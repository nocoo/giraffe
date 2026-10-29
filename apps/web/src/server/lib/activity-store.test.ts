import { expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { ActivityRepo, ActivitySnapshot } from "../../lib/activity-types";
import { activityTotals, unknownActivity } from "./activity";
import { readActivity } from "./activity-store";
import { createDb } from "./db/d1";
import { resolveFactoryRunReference } from "./db/factory-runs";
import { replaceSnapshotStmts } from "./db/snapshots";

const at = "2026-10-22T00:00:00.000Z";
function repository(): ActivityRepo {
	return {
		repo: "owner/app",
		ci_runs: [],
		prs: { opened: [], merged: [], closed: [] },
		issues: { opened: [], closed: [] },
		releases: [],
		commits: { default: null, other: null, items: null },
		deploy: { last_success_at: null, runs: null },
		snapshot: { open_prs: null, open_issues: null, dependabot: null, code_scanning: null },
		coverage: Object.fromEntries(
			["actions", "prs", "issues", "releases", "default_branch"].map((stream) => [
				stream,
				{ status: "complete", truncated: false, reason: null },
			]),
		),
	};
}
async function fixture() {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake',?,?)",
		)
		.bind(at, at)
		.run();
	const run = async (id: string, status = "completed") =>
		db
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,'a',?,?,'{}',?,?,?)",
			)
			.bind(id, id, status, at, at, at)
			.run();
	await run("saved-activity");
	const repo = repository();
	const snapshot: ActivitySnapshot = {
		account_id: "a",
		runId: "saved-activity",
		previousRunId: null,
		window: { since: "2026-10-21T00:00:00.000Z", until: at, first: true, gap: true },
		fetchedAt: at,
		membership: [repo.repo],
		repos: [],
		totals: activityTotals([]),
		contributions: null,
		coverage: {},
		truncated: false,
	};
	const publish = async (repos: ActivityRepo[] = [repo]) => {
		await db
			.prepare(
				"INSERT INTO activity_publications(account_id,run_id,until_at,fetched_at,payload,content_version) VALUES('a',?,?,?,?,?) ON CONFLICT(account_id,run_id) DO UPDATE SET payload=excluded.payload",
			)
			.bind(snapshot.runId, at, at, JSON.stringify(snapshot), "saved-content")
			.run();
		await db
			.prepare(
				"INSERT INTO activity_pages(account_id,run_id,page,payload) VALUES('a',?,0,?) ON CONFLICT(account_id,run_id,page) DO UPDATE SET payload=excluded.payload",
			)
			.bind(snapshot.runId, JSON.stringify(repos))
			.run();
	};
	const catalog = async (repos: unknown[]) =>
		db.batch(await replaceSnapshotStmts(db, "a", "repos", { repos }, at));
	return { db, raw, repo, snapshot, run, publish, catalog };
}

it("reads the latest saved publication and repository projection without collection or writes", async () => {
	const saved = await fixture();
	await saved.publish();
	const before = await saved.raw.prepare("SELECT * FROM activity_publications").all();
	const upstream = vi.spyOn(globalThis, "fetch");
	expect(await readActivity(saved.db, "a", {})).toMatchObject({
		runId: "saved-activity",
		repos: [{ repo: "owner/app" }],
		totals_partial: false,
	});
	expect(
		await readActivity(saved.db, "a", { run: ["saved"], repository: ["OWNER/APP"] }),
	).toMatchObject({
		repos: [{ repo: "owner/app" }],
		contributions: null,
		coverage: { repos: { status: "unavailable" } },
	});
	expect(await saved.raw.prepare("SELECT * FROM activity_publications").all()).toEqual(before);
	expect(upstream).not.toHaveBeenCalled();
	upstream.mockRestore();
});

it("distinguishes frozen omissions from a current catalog member outside the saved run", async () => {
	const saved = await fixture();
	saved.snapshot.membership = ["owner/omitted"];
	await saved.publish([]);
	expect(await readActivity(saved.db, "a", { repository: ["owner/omitted"] })).toMatchObject({
		truncated: true,
		coverage: { repos: { status: "partial" } },
		totals: { ci_runs: null },
	});
	await saved.catalog([{ name_with_owner: "owner/current" }, {}]);
	expect(await readActivity(saved.db, "a", { repository: ["owner/current"] })).toMatchObject({
		truncated: false,
		repos: [],
		coverage: { repos: { status: "complete" } },
	});
	await expect(readActivity(saved.db, "a", { repository: ["outside/repo"] })).rejects.toMatchObject(
		{ status: 404 },
	);
	await saved.catalog([]);
	await expect(readActivity(saved.db, "a", { repository: ["outside/repo"] })).rejects.toMatchObject(
		{ status: 404 },
	);
});

it("retains legacy missing membership and unavailable evidence instead of reporting successful zeroes", async () => {
	const saved = await fixture();
	delete saved.snapshot.membership;
	saved.snapshot.truncated = true;
	saved.repo.coverage.actions = unknownActivity("not observed", true);
	await saved.publish();
	expect(await readActivity(saved.db, "a", {})).toMatchObject({ totals_partial: true });
	expect(await readActivity(saved.db, "a", { repository: ["owner/app"] })).toMatchObject({
		truncated: true,
	});
	await saved.catalog([{ name_with_owner: "owner/omitted" }]);
	expect(await readActivity(saved.db, "a", { repository: ["owner/omitted"] })).toMatchObject({
		truncated: true,
		coverage: { repos: { status: "partial" } },
	});
	saved.snapshot.truncated = false;
	saved.snapshot.coverage.repos = { status: "partial", truncated: false, reason: "saved" };
	await saved.publish();
	expect(await readActivity(saved.db, "a", { repository: ["owner/app"] })).toMatchObject({
		coverage: { repos: { reason: "saved" } },
	});
});

it("validates saved-run references and filters without invoking legacy orchestration", async () => {
	const saved = await fixture();
	for (const query of [{ run: ["saved", "saved"] }, { invalid: ["x"] }, { repository: ["bad"] }])
		await expect(readActivity(saved.db, "a", query)).rejects.toMatchObject({ status: 400 });
	await expect(readActivity(saved.db, "a", {})).rejects.toMatchObject({
		status: 409,
		code: "activity_unpublished",
	});
	await expect(readActivity(saved.db, "a", { run: ["missing"] })).rejects.toMatchObject({
		status: 404,
	});
	await expect(readActivity(saved.db, "a", { run: ["saved"] })).rejects.toMatchObject({
		status: 409,
	});
	await saved.run("saved-another");
	await expect(resolveFactoryRunReference(saved.db, "a", "saved")).rejects.toMatchObject({
		status: 400,
	});
	expect(await resolveFactoryRunReference(saved.db, "a", "latest")).toBe("latest");
	await saved.publish();
	await saved.db.prepare("DELETE FROM activity_pages").run();
	expect(await readActivity(saved.db, "a", {})).toMatchObject({ repos: [], totals_partial: true });
});
