import { describe, expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
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
	const save = async (kind: string, payload: Record<string, unknown>, fetchedAt = at) => {
		const db = createDb(raw);
		await db.batch(replaceSnapshotStmts(db, id, kind, payload, fetchedAt));
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
	it("scopes all aggregates and missing dependencies before deriving the report", async () => {
		const fixture = await setup();
		const old = "2026-09-01T00:00:00.000Z";
		const recent = "2026-09-19T00:00:00.000Z";
		await fixture.save("repos", {
			repos: [
				"nocoo/app",
				"nocoo/empty",
				"nocoo/unseen",
				"nocoo/hidden",
				"nocoo/hidden-unsaved",
			].map((name_with_owner) => ({ name_with_owner })),
		});
		for (const repo of ["NOCOO/APP", "nocoo/empty", "nocoo/unseen"])
			await fixture.raw.prepare("INSERT INTO repo_stars VALUES(?,?)").bind(id, repo).run();
		await fixture.save("repo:nocoo/app:actions", { runs: [run("CI", "success", at)] });
		await fixture.save("repo:nocoo/app:details", { default_branch: "main" }, old);
		await fixture.save("repo:nocoo/app:releases", { releases: [] }, recent);
		await fixture.save("repo:nocoo/empty:actions", { runs: [] }, recent);
		await fixture.save(
			"repo:nocoo/hidden:actions",
			{ runs: [run("CI", "failure", at), run("CI", "failure", old)] },
			old,
		);
		const before = await fixture.raw.prepare("SELECT * FROM snapshots ORDER BY kind").all();
		const response = await fixture.call("/api/ci?scope=starred");
		expect(response.status).toBe(200);
		const body = (await response.json()) as CiReportResponse;
		expect(body.repos.map((repo) => repo.repo)).toEqual(["nocoo/app", "nocoo/empty"]);
		expect(body.unsaved).toEqual(["nocoo/unseen"]);
		expect(body.totals).toMatchObject({ repos: 2, broken: 0, healthy: 1 });
		expect(body.daily.reduce((total, day) => total + day.failure, 0)).toBe(0);
		expect(body).toMatchObject({
			fetched_at: recent,
			now: recent,
			freshness: { oldestAt: old, latestAt: recent, total: 9, missing: 5 },
		});
		expect(await fixture.raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(
			before,
		);
	});

	it("returns an empty successful report for no stars and rejects invalid scope", async () => {
		const fixture = await setup();
		expect((await fixture.call("/api/ci?scope=starred")).status).toBe(200);
		await fixture.save("repos", { repos: [{ name_with_owner: "nocoo/app" }] });
		await fixture.save("repo:nocoo/app:actions", { runs: [run("CI", "failure", at)] });
		const response = await fixture.call("/api/ci?scope=starred");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			repos: [],
			streams: [],
			unsaved: [],
			totals: { repos: 0 },
			fetched_at: "",
			freshness: { oldestAt: null, latestAt: null, total: 0, missing: 0 },
		});
		expect((await fixture.call("/api/ci?scope=invalid")).status).toBe(400);
	});

	it("keeps unavailable dependencies missing and uses primary saved checks rather than source event times", async () => {
		const fixture = await setup();
		await fixture.save("repos", {
			repos: [{ name_with_owner: "nocoo/app" }, { name_with_owner: "nocoo/unavailable" }],
		});
		await fixture.save("repo:nocoo/app:actions", { runs: [] });
		await fixture.save("repo:nocoo/app:details", { forbidden: true }, "2026-10-01T00:00:00.000Z");
		await fixture.save(
			"repo:nocoo/app:releases",
			{ unavailable: true },
			"2026-10-01T00:00:00.000Z",
		);
		await fixture.save(
			"repo:nocoo/unavailable:actions",
			{ unavailable: true },
			"2026-10-01T00:00:00.000Z",
		);
		expect(await (await fixture.call()).json()).toMatchObject({
			fetched_at: at,
			unsaved: ["nocoo/unavailable"],
			freshness: { oldestAt: at, latestAt: at, total: 6, missing: 5 },
		});
	});

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
