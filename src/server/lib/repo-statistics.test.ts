import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { factoryFixture } from "../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../tests/fixtures/sqlite";
import { createDb } from "./db/d1";
import { replaceSnapshotStmts } from "./db/snapshots";
import { repoPolicy, statisticsFactory, statisticsSnapshot } from "./repo-statistics";

it("keeps raw snapshots immutable and applies defaults to factory-only catalog entries", async () => {
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
	expect(statisticsFactory(snapshot, policy).inventory.excluded).toEqual([
		{ name: "outside/other", reason: "not-owner" },
		{ name: first.name, reason: "statistics-disabled" },
	]);
	expect(snapshot).toEqual(before);
	expect(await statisticsSnapshot(db, "absent", "unknown", { fetched_at: "t" })).toEqual({
		fetched_at: "t",
	});
	expect(await statisticsSnapshot(db, "absent", "issues", {})).toEqual({});
	expect(
		await statisticsSnapshot(db, "absent", "alerts", { items: [{ source: "code_scanning" }, {}] }),
	).toMatchObject({ code_scanning_open: 1, dependabot_open: 0 });
});

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
	expect(await statisticsSnapshot(db, "a", "digest", { fetched_at: "2026-09-18" })).toMatchObject({
		baseline_missing: true,
		stars_delta: null,
		repos: [{ name_with_owner: "o/r" }],
	});
	expect(await statisticsSnapshot(db, "a", "insights", { fetched_at: "2026-09-18" })).toMatchObject(
		{ alerts_incomplete: true, insights: [{ name_with_owner: "o/r", open_issue_count: 0 }] },
	);
});

it("applies the additive migration repeatedly without losing existing rows", () => {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync("src/server/lib/db/schema.sql", "utf8"));
	db.exec(
		"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','user','encrypted','fake','t','t'); INSERT INTO repo_statistics VALUES('a','o/r',0)",
	);
	const migration = readFileSync("migrations/0004_repo_statistics.sql", "utf8");
	db.exec(migration);
	db.exec(migration);
	expect(db.prepare("SELECT enabled FROM repo_statistics").get()).toMatchObject({ enabled: 0 });
	db.close();
});
