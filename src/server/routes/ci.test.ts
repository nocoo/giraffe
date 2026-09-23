import { describe, expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../tests/fixtures/sqlite";
import type { CiReportResponse } from "../../lib/ci-health";
import type { Env } from "../env";
import { createApp } from "../index";
import { createDb } from "../lib/db/d1";
import { replaceSnapshotStmts } from "../lib/db/snapshots";

const id = "account_ci_000000001";
const at = "2026-09-18T12:00:00.000Z";
const run = (name: string, conclusion: string | null, created: string, branch = "main") => ({
	id: Date.parse(created),
	name,
	html_url: "https://github.com/x",
	status: conclusion ? "completed" : "in_progress",
	conclusion,
	event: "push",
	head_branch: branch,
	created_at: created,
	updated_at: created,
});

async function setup(withAccount = true) {
	const raw = sqliteFixture();
	if (withAccount)
		await raw
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?,?,?,?,1,?,?)",
			)
			.bind(id, "nocoo", "encrypted", "fake", at, at)
			.run();
	const env = {
		FACTORY_QUEUE: {} as Queue,
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
		DB: raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://127.0.0.1:17046",
		ASSETS: { fetch: async () => new Response() } as unknown as Fetcher,
	} satisfies Env;
	const save = async (kind: string, payload: Record<string, unknown>) => {
		const db = createDb(raw);
		await db.batch(replaceSnapshotStmts(db, id, kind, payload, at));
	};
	const app = createApp();
	return {
		save,
		raw,
		call: (path = "/api/ci", method = "GET") =>
			app.request(
				`http://localhost${path}`,
				{ method, headers: { origin: "https://giraffe.dev.hexly.ai" } },
				env,
			),
	};
}

describe("GET /api/ci", () => {
	it("classifies saved runs per repository without contacting GitHub or writing data", async () => {
		const s = await setup();
		await s.save("repos", {
			repos: [
				{ name_with_owner: "nocoo/app", is_fork: false, is_archived: false },
				{ name_with_owner: "nocoo/quiet", is_fork: false, is_archived: false },
				{ name_with_owner: "nocoo/old", is_fork: false, is_archived: true },
			],
		});
		await s.save("repo:nocoo/app:details", { default_branch: "main" });
		await s.save("repo:nocoo/app:actions", {
			runs: [
				run("Release", "failure", "2026-09-18T10:00:00Z"),
				run("Release", "failure", "2026-09-17T10:00:00Z"),
				run("CI", "success", "2026-09-18T09:00:00Z"),
			],
		});
		await s.save("repo:nocoo/app:releases", {
			releases: [
				{
					id: 1,
					tag_name: "v1.1.0",
					name: null,
					html_url: "",
					draft: false,
					prerelease: false,
					published_at: "2026-09-16T00:00:00Z",
				},
			],
		});
		await s.save("repo:nocoo/quiet:actions", {
			runs: [run("CI", "success", "2026-09-18T08:00:00Z")],
		});
		await s.save("repo:nocoo/old:actions", {
			runs: [
				run("CI", "failure", "2026-09-18T08:00:00Z"),
				run("CI", "failure", "2026-09-17T08:00:00Z"),
			],
		});
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const before = (
			await s.raw.prepare("SELECT COUNT(*) AS n FROM snapshots").first<{ n: number }>()
		)?.n;
		const res = await s.call();
		vi.unstubAllGlobals();
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		const body = (await res.json()) as CiReportResponse;
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(
			(await s.raw.prepare("SELECT COUNT(*) AS n FROM snapshots").first<{ n: number }>())?.n,
		).toBe(before);
		expect(body.account_id).toBe(id);
		expect(body.repos.map((r) => [r.repo, r.verdict])).toEqual([
			["nocoo/app", "broken"],
			["nocoo/quiet", "healthy"],
		]);
		expect(body.repos[0]?.release).toMatchObject({ latest: "v1.1.0", pipeline: "broken" });
		expect(body.streams[0]).toMatchObject({ repo: "nocoo/app", workflow: "Release", streak: 2 });
		expect(body.unsaved).toEqual([]);
		expect(body.fetched_at).toBe(at);
		expect(body.truncated).toBe(false);
		expect(body.totals).toMatchObject({ broken: 1, healthy: 2, repos: 2 });
	});

	it("reports repositories without saved runs instead of counting them healthy", async () => {
		const s = await setup();
		await s.save("repos", {
			repos: [
				{ name_with_owner: "nocoo/app", is_fork: false, is_archived: false },
				{ name_with_owner: "nocoo/unseen", is_fork: false, is_archived: false },
			],
		});
		await s.save("repo:nocoo/app:actions", {
			runs: [run("CI", "success", "2026-09-18T08:00:00Z")],
		});
		const body = (await (await s.call()).json()) as CiReportResponse;
		expect(body.unsaved).toEqual(["nocoo/unseen"]);
		expect(body.repos.map((r) => r.repo)).toEqual(["nocoo/app"]);
	});

	it("returns snapshot_missing without saved repositories and account_missing without an account", async () => {
		const empty = await setup();
		const res = await empty.call();
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ error: { code: "snapshot_missing" } });
		const none = await setup(false);
		expect(await (await none.call()).json()).toMatchObject({ error: { code: "account_missing" } });
		expect((await empty.call("/api/ci", "POST")).status).toBe(405);
	});
});
