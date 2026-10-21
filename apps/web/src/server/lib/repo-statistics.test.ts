import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { createDb } from "./db/d1";
import { replaceSnapshotStmts } from "./db/snapshots";
import { repoPolicy, statisticsFactory, statisticsSnapshot } from "./repo-statistics";

it("uses saved catalog membership for all selectors and never revives removed repositories", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t')",
		)
		.run();
	await db.batch(
		replaceSnapshotStmts(
			db,
			"a",
			"repos",
			{ repos: [{ name_with_owner: "Owner/App" }] },
			"2026-10-18",
		),
	);
	await db.prepare("INSERT INTO repo_stars VALUES('a','owner/removed')").run();
	await db.prepare("INSERT INTO repo_statistics VALUES('a','owner/removed',1)").run();
	const all = await repoPolicy(db, "a");
	expect(all.includes("OWNER/APP")).toBe(true);
	expect(all.includes("owner/removed")).toBe(false);
	expect(all.enabled("owner/removed")).toBe(false);
	const stars = await repoPolicy(db, "a", undefined, "starred");
	expect(stars.includes("owner/removed")).toBe(false);
	expect(stars.empty).toBe(true);
	for (const [kind, key] of [
		["issues", "issues"],
		["prs", "pull_requests"],
		["notifications", "notifications"],
		["alerts", "items"],
	]) {
		const snapshot = {
			[String(key)]: [{ name_with_owner: "OWNER/APP" }, { name_with_owner: "owner/removed" }],
			fetched_at: "2026-10-18",
		};
		expect(await statisticsSnapshot(db, "a", String(kind), snapshot)).toMatchObject({
			[String(key)]: [{ name_with_owner: "OWNER/APP" }],
			freshness: { total: 1 },
		});
	}
});

it("includes baseline timestamps for the entire catalog and for served incomplete data", async () => {
	const db = createDb(sqliteFixture());
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t')",
		)
		.run();
	const baseline = "2026-10-18T12:50:00Z";
	const recent = "2026-10-20T12:02:00Z";
	await db.batch(
		replaceSnapshotStmts(
			db,
			"a",
			"repos",
			{
				repos: ["owner/app", "owner/baseline", "owner/empty"].map((name_with_owner) => ({
					name_with_owner,
				})),
			},
			baseline,
		),
	);
	for (const [kind, key] of [
		["issues", "issues"],
		["prs", "pull_requests"],
		["repos", "repos"],
	]) {
		const snapshot = {
			[String(key)]: ["owner/app", "owner/baseline"].map((name_with_owner) => ({
				name_with_owner,
			})),
			repository_fetched_at: { "OWNER/APP": recent, "owner/removed": recent },
			fetched_at: baseline,
			truncated: false,
		};
		const result = await statisticsSnapshot(db, "a", String(kind), snapshot);
		expect(result).toMatchObject({
			fetched_at: recent,
			freshness: {
				total: kind === "repos" ? 2 : 3,
				missing: 0,
				oldestAt: baseline,
				latestAt: recent,
			},
		});
		expect(result.repository_fetched_at).not.toHaveProperty("owner/removed");
	}
	const partial = await statisticsSnapshot(db, "a", "issues", {
		issues: [{ name_with_owner: "owner/baseline" }],
		fetched_at: baseline,
		truncated: true,
	});
	expect(partial).toMatchObject({
		fetched_at: baseline,
		freshness: { oldestAt: baseline, latestAt: baseline, total: 3, missing: 2 },
	});
});

it("keeps raw snapshots immutable and excludes factory entries without a saved catalog", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	const snapshot = factoryFixture();
	const first = snapshot.repos[0];
	if (!first) throw new Error("fixture");
	snapshot.repos = [{ ...first, is_fork: true }];
	snapshot.inventory.excluded = [
		{ name: first.name, reason: "fork" },
		{ name: "outside/other", reason: "not-owner" },
	];
	const before = structuredClone(snapshot);
	const policy = await repoPolicy(db, "absent");
	expect(statisticsFactory(snapshot, policy).repos).toEqual([]);
	expect(statisticsFactory(snapshot, policy).inventory.excluded).toEqual([]);
	expect(snapshot).toEqual(before);
	expect(await statisticsSnapshot(db, "absent", "unknown", { fetched_at: "t" })).toEqual({
		fetched_at: "t",
	});
	expect(await statisticsSnapshot(db, "absent", "issues", {})).toEqual({});
	expect(
		await statisticsSnapshot(db, "absent", "alerts", { items: [{ source: "code_scanning" }, {}] }),
	).toMatchObject({ code_scanning_open: 0, dependabot_open: 0 });
});

it.each([
	["issues", "issues", "issues"],
	["prs", "pull_requests", "prs"],
	["alerts", "items", "security"],
])(
	"preserves incomplete %s coverage independently of observed timestamps",
	async (kind, key, suffix) => {
		const db = createDb(sqliteFixture());
		await db
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t')",
			)
			.run();
		const at = "2026-10-18T12:50:00Z";
		await db.batch(
			replaceSnapshotStmts(db, "a", "repos", { repos: [{ name_with_owner: "owner/app" }] }, at),
		);
		await db.prepare("INSERT INTO repo_stars VALUES('a','owner/app')").run();
		const partial = {
			[key]: [{ name_with_owner: "owner/app", number: 1 }],
			fetched_at: at,
			truncated: true,
		};
		expect(await statisticsSnapshot(db, "a", kind, partial, "starred")).toMatchObject({
			truncated: true,
			freshness: { total: 1, missing: 0, oldestAt: at },
		});
		await db.batch(replaceSnapshotStmts(db, "a", `repo:owner/app:${suffix}`, { [key]: [] }, at));
		expect(await statisticsSnapshot(db, "a", kind, partial, "starred")).toMatchObject({
			[key]: [],
			truncated: false,
			freshness: { total: 1, missing: 0, oldestAt: at },
		});
	},
);

it("handles first-day baselines and incomplete source metadata without invented deltas", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','user','encrypted','fake','t','t')",
		)
		.run();
	await db.batch(
		replaceSnapshotStmts(
			db,
			"a",
			"repos",
			{ repos: [null, {}, { name_with_owner: "o/r", pushed_at: "2026-09-01" }], truncated: true },
			"2026-09-18",
		),
	);
	expect(await statisticsSnapshot(db, "a", "insights", { fetched_at: "2026-09-18" })).toMatchObject(
		{ alerts_incomplete: true, insights: [{ name_with_owner: "o/r", open_issue_count: 0 }] },
	);
});

it("applies the additive migration repeatedly without losing existing rows", () => {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8"));
	db.exec(
		"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','user','encrypted','fake','t','t'); INSERT INTO repo_statistics VALUES('a','o/r',0)",
	);
	const migration = readFileSync("migrations/0004_repo_statistics.sql", "utf8");
	db.exec(migration);
	db.exec(migration);
	expect(db.prepare("SELECT enabled FROM repo_statistics").get()).toMatchObject({ enabled: 0 });
	db.close();
});
