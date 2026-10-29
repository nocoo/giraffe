import { expect, it, vi } from "vitest";
import { refreshActivityFixture } from "../../../../../tests/fixtures/refresh-activity";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { FactorySnapshot, FactoryStreamData } from "../../lib/factory-types";
import { readActivity } from "./activity-store";
import { createDb } from "./db/d1";
import { resolveFactoryRunReference } from "./db/factory-runs";
import { replaceSnapshotStmts } from "./db/snapshots";

it("projects newly refreshed repository lifecycle events without pretending daily commit totals are owner commits", async () => {
	const { raw, now } = await refreshActivityFixture();
	const network = vi.spyOn(globalThis, "fetch");
	const before = await raw.prepare("SELECT * FROM refresh_resources ORDER BY repo_id,stream").all();
	try {
		const activity = await readActivity(createDb(raw), "a", {});
		expect(activity).toMatchObject({
			runId: "current-refresh",
			fetchedAt: now,
			membership: ["owner/app"],
			totals: { issues_opened: 1, issues_closed: 1, merged_prs: 1, ci_runs: 1, releases: 1 },
		});
		expect(activity.repos[0]).toMatchObject({
			issues: {
				opened: [{ author: "collaborator", id: "I_1", closed_by: null }],
				closed: [{ id: "I_1" }],
			},
			prs: {
				opened: [{ id: "P_1", author: "collaborator" }],
				merged: [{ id: "P_1", merged_by: null }],
				closed: [{ id: "P_1" }],
			},
			commits: { default: null, other: null, items: null },
			coverage: {
				commits: { status: "unavailable" },
				issues: { status: "complete" },
				prs: { status: "complete" },
			},
		});
		expect(network).not.toHaveBeenCalled();
		expect(
			await raw.prepare("SELECT * FROM refresh_resources ORDER BY repo_id,stream").all(),
		).toEqual(before);
	} finally {
		network.mockRestore();
	}
});

it("resolves current run aliases but never presents mutable current resources as a historical run", async () => {
	const { raw, now } = await refreshActivityFixture();
	const db = createDb(raw);
	for (const run of ["latest", "current", "current-refresh"])
		expect(await readActivity(db, "a", { run: [run], repository: ["OWNER/APP"] })).toMatchObject({
			runId: "current-refresh",
			membership: ["owner/app"],
		});
	await raw
		.prepare(
			"INSERT INTO refresh_runs(id,account_id,status,trigger,payload,created_at,updated_at) VALUES('previous','a','completed','manual','{}',?,?)",
		)
		.bind(now, now)
		.run();
	await expect(readActivity(db, "a", { run: ["previous"] })).rejects.toMatchObject({
		status: 409,
		code: "activity_unpublished",
	});
});

it("uses current immutable catalog identity after a rename and ignores retired identity and activity poison", async () => {
	const { raw } = await refreshActivityFixture();
	await raw.prepare("UPDATE refresh_catalog SET repo='owner/renamed' WHERE repo_id='R_APP'").run();
	await raw
		.prepare(
			"INSERT INTO catalog_repositories(account_id,identity_key,github_id,repo,row_payload,is_archived,visibility,is_fork,first_seen_source) VALUES('a','RETIRED','RETIRED','owner/renamed','{}',0,'PUBLIC',0,'github_catalog')",
		)
		.run();
	await raw
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('retired','a','retired','completed','{}','future','future','future')",
		)
		.run();
	await raw
		.prepare(
			"INSERT INTO activity_publications(account_id,run_id,until_at,fetched_at,payload,content_version) VALUES('a','retired','future','future','not-json','poison')",
		)
		.run();
	const result = await readActivity(createDb(raw), "a", { repository: ["OWNER/RENAMED"] });
	expect(result).toMatchObject({
		membership: ["owner/renamed"],
		runId: "current-refresh",
		repos: [{ repo: "owner/renamed", issues: { opened: [{ id: "I_1" }] } }],
	});
	expect(result.repos[0]?.coverage.issues?.source?.runId).toBe("current-refresh");
	await expect(
		readActivity(createDb(raw), "a", { repository: ["owner/app"] }),
	).rejects.toMatchObject({ status: 404 });
});

it("keeps newly discovered current members missing rather than zero and excludes inactive or foreign repositories", async () => {
	const { raw, now } = await refreshActivityFixture();
	for (const [id, repo, active] of [
		["R_NEW", "owner/new", 1],
		["R_FOREIGN", "someone/foreign", 1],
		["R_GONE", "owner/gone", 0],
	] as const)
		await raw
			.prepare(
				"INSERT INTO refresh_catalog(account_id,repo_id,repo,discovered_day,timezone,payload,fetched_at,active) VALUES('a',?,?,'2026-10-28','Asia/Shanghai','{}',?,?)",
			)
			.bind(id, repo, now, active)
			.run();
	const db = createDb(raw);
	const result = await readActivity(db, "a", {});
	expect(result.membership).toEqual(["owner/app", "owner/new"]);
	expect(result.repos[1]).toMatchObject({
		repo: "owner/new",
		issues: { opened: null, closed: null },
		coverage: { issues: { status: "unavailable" } },
	});
	expect(result.totals).toMatchObject({ issues_opened: 1 });
	expect(result.totals_coverage.missing).toContainEqual({
		repo: "owner/new",
		reason: "unavailable",
		metrics: [
			"ci_runs",
			"merged_prs",
			"dependency_prs",
			"other_prs",
			"issues_opened",
			"issues_closed",
			"releases",
			"red_default_branch",
		],
	});
	for (const repository of ["owner/gone", "someone/foreign"])
		await expect(readActivity(db, "a", { repository: [repository] })).rejects.toMatchObject({
			status: 404,
		});
});

it("keeps canonical publication and per-stream truncation visible without inventing full totals", async () => {
	const { raw, now } = await refreshActivityFixture();
	const db = createDb(raw);
	const row = await raw
		.prepare("SELECT payload FROM refresh_snapshots WHERE kind='factory'")
		.first<{ payload: string }>();
	if (!row) throw new Error("factory fixture missing");
	const publication = JSON.parse(row.payload) as FactorySnapshot;
	publication.inventory.complete = false;
	publication.truncated = true;
	delete publication.publication;
	await db.batch(
		await replaceSnapshotStmts(
			db,
			"a",
			"factory",
			publication as unknown as Record<string, unknown>,
			now,
		),
	);
	const source = await raw
		.prepare("SELECT payload FROM refresh_resources WHERE stream='issues'")
		.first<{ payload: string }>();
	if (!source) throw new Error("issue fixture missing");
	const data = JSON.parse(source.payload) as FactoryStreamData;
	data.coverage.status = "limited";
	data.coverage.reason = "incomplete_pagination";
	await raw
		.prepare("UPDATE refresh_resources SET payload=? WHERE stream='issues'")
		.bind(JSON.stringify(data))
		.run();
	const result = await readActivity(db, "a", {});
	expect(result).toMatchObject({
		fetchedAt: now,
		truncated: true,
		totals: { issues_opened: null },
		coverage: { repos: { status: "partial", truncated: true, reason: "catalog_incomplete" } },
	});
	expect(result.repos[0]?.issues.opened).toHaveLength(1);
	expect(result.repos[0]?.coverage.issues).toMatchObject({ status: "partial", truncated: true });
	expect(result.totals_coverage.missing).toContainEqual({
		repo: null,
		reason: "omitted",
		metrics: expect.arrayContaining(["issues_opened"]),
	});
});

it.each([0, 1, 2, 3])(
	"rejects incomplete canonical activity batches with only %i result sets",
	async (count) => {
		const { raw } = await refreshActivityFixture();
		const db = createDb(raw);
		const batch = db.batch.bind(db);
		vi.spyOn(db, "batch").mockImplementation((statements) => batch(statements.slice(0, count)));
		await expect(readActivity(db, "a", {})).rejects.toMatchObject({
			status: 500,
			code: "db_error",
		});
	},
);

it("keeps one canonical publication coherent across a concurrent publish", async () => {
	const { raw, now } = await refreshActivityFixture();
	const db = createDb(raw);
	const batch = db.batch.bind(db);
	const publish = async (runId: string) => {
		const row = await raw
			.prepare("SELECT payload FROM refresh_snapshots WHERE kind='factory'")
			.first<{ payload: string }>();
		if (!row) throw new Error("missing publication");
		const snapshot = JSON.parse(row.payload) as FactorySnapshot;
		const at = "2026-10-29T05:00:00.000Z";
		await raw
			.prepare("UPDATE refresh_snapshots SET payload=?,fetched_at=? WHERE kind='factory'")
			.bind(
				JSON.stringify({
					...snapshot,
					runId,
					fetched_at: at,
					publication: { mixed: false, runId, publishedAt: at },
					repos: snapshot.repos.map((repo) => ({
						...repo,
						observation: { ...repo.observation, version: runId },
					})),
				}),
				at,
			)
			.run();
	};
	const interleave = vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
		const result = await batch(statements);
		await publish("new-refresh");
		return result;
	});
	try {
		const coherent = await readActivity(db, "a", {});
		expect(coherent).toMatchObject({
			runId: "current-refresh",
			fetchedAt: now,
			membership: ["owner/app"],
			repos: [{ issues: { opened: [{ id: "I_1" }] } }],
		});
		expect(coherent.repos[0]?.coverage.issues).toMatchObject({ status: "complete" });
		expect(interleave).toHaveBeenCalledTimes(1);
	} finally {
		interleave.mockRestore();
	}
	const mixed = await readActivity(db, "a", {});
	expect(mixed.runId).toBe("new-refresh");
	expect(mixed.repos[0]?.issues.opened).toBeNull();
	expect(mixed.repos[0]?.coverage.issues).toMatchObject({
		status: "unavailable",
		reason: "source_version_mismatch",
	});
	await raw
		.prepare("UPDATE refresh_resources SET payload=json_set(payload,'$.runId','new-refresh')")
		.run();
	const switched = await readActivity(db, "a", {});
	expect(switched).toMatchObject({
		runId: "new-refresh",
		membership: ["owner/app"],
		repos: [{ issues: { opened: [{ id: "I_1" }] } }],
	});
});

async function fixture() {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t')",
		)
		.run();
	const run = async (id: string, account = "a", status = "completed") =>
		raw
			.prepare(
				"INSERT INTO refresh_runs(id,account_id,status,trigger,payload,created_at,updated_at) VALUES(?,?,?,'manual','{}','t','t')",
			)
			.bind(id, account, status)
			.run();
	return { raw, db: createDb(raw), run };
}

it("keeps new activity explicitly unavailable without reading retired publications or collecting", async () => {
	const { raw, db, run } = await fixture();
	await run("saved-activity");
	await raw
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('retired','a','retired','completed','{}','t','t','t')",
		)
		.run();
	await raw
		.prepare(
			"INSERT INTO activity_publications(account_id,run_id,until_at,fetched_at,payload,content_version) VALUES('a','retired','t','t','not-json','retired')",
		)
		.run();
	const fetch = vi.spyOn(globalThis, "fetch");
	try {
		for (const query of [{}, { run: ["saved"] }, { run: ["latest"] }])
			await expect(readActivity(db, "a", query)).rejects.toMatchObject({
				status: 409,
				code: "activity_unpublished",
			});
		expect(fetch).not.toHaveBeenCalled();
		expect((await raw.prepare("SELECT payload FROM activity_publications").all()).results).toEqual([
			{ payload: "not-json" },
		]);
	} finally {
		fetch.mockRestore();
	}
});

it("validates filters, current membership and account-scoped refresh references", async () => {
	const { raw, db, run } = await fixture();
	for (const query of [{ run: ["x", "x"] }, { invalid: ["x"] }, { repository: ["invalid"] }])
		await expect(readActivity(db, "a", query)).rejects.toMatchObject({ status: 400 });
	await expect(readActivity(db, "a", { run: ["missing"] })).rejects.toMatchObject({ status: 404 });
	await expect(readActivity(db, "a", { repository: ["owner/app"] })).rejects.toMatchObject({
		status: 404,
	});
	await raw
		.prepare(
			"INSERT INTO refresh_catalog(account_id,repo_id,repo,discovered_day,timezone,payload,fetched_at) VALUES('a','R_1','owner/app','2026-10-29','Asia/Shanghai','{}','t')",
		)
		.run();
	await expect(readActivity(db, "a", { repository: ["OWNER/APP"] })).rejects.toMatchObject({
		status: 409,
	});
	await run("saved-one");
	await run("saved-two");
	await expect(resolveFactoryRunReference(db, "a", "saved")).rejects.toMatchObject({ status: 400 });
	expect(await resolveFactoryRunReference(db, "a", "saved-one")).toBe("saved-one");
	expect(await resolveFactoryRunReference(db, "a", "latest")).toBe("latest");
	await expect(resolveFactoryRunReference(db, "other", "saved-one")).rejects.toMatchObject({
		status: 404,
	});
	await expect(resolveFactoryRunReference(db, "a", "saved_")).rejects.toMatchObject({
		status: 404,
	});
	await run("a".repeat(36));
	await run(`${"a".repeat(36)}-tail`);
	expect(await resolveFactoryRunReference(db, "a", "a".repeat(36))).toBe("a".repeat(36));
});
