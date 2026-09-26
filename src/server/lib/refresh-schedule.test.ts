import { expect, it } from "vitest";
import { factoryFixture } from "../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../tests/fixtures/sqlite";
import { createDb } from "./db/d1";
import { replaceSnapshotStmts } from "./db/snapshots";
import { nextScheduleAt, readSchedules, saveSchedule, scheduleRefreshes } from "./refresh-schedule";

const snap = factoryFixture();
const now = "2026-09-27T00:00:00.000Z";
async function setup() {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?,?,?,?,?)",
		)
		.bind(snap.account_id, "nocoo", "fake", "fake", now, now)
		.run();
	await db.batch(replaceSnapshotStmts(db, snap.account_id, "factory", snap, now));
	await db.batch(
		replaceSnapshotStmts(
			db,
			snap.account_id,
			"repos",
			{ truncated: false, repos: snap.repos.map((r) => ({ name_with_owner: r.name })) },
			now,
		),
	);
	return { raw, db };
}
it("computes fixed Beijing wall-clock times across day/week/year boundaries", () => {
	expect(nextScheduleAt("daily", "08:00", 0, now)).toBe("2026-09-28T00:00:00.000Z");
	expect(nextScheduleAt("weekly", "04:00", 0, now)).toBe("2026-10-03T20:00:00.000Z");
	expect(nextScheduleAt("daily", "00:00", 0, "2026-12-31T15:59:00.000Z")).toBe(
		"2026-12-31T16:00:00.000Z",
	);
});
it("starts one durable starred quick run and makes concurrent cron ticks idempotent", async () => {
	const s = await setup();
	await s.db
		.prepare("INSERT INTO repo_stars(account_id,repo) VALUES(?,?)")
		.bind(snap.account_id, "nocoo/app")
		.run();
	await saveSchedule(
		s.db,
		snap.account_id,
		"daily",
		{ enabled: true, time: "08:00", weekday: 0, scope: "starred" },
		"2026-09-26T00:01:00.000Z",
	);
	await scheduleRefreshes(s.raw, now);
	await scheduleRefreshes(s.raw, now);
	const rows = await s.db.prepare("SELECT payload FROM factory_runs").all<{ payload: string }>();
	expect(rows.results).toHaveLength(1);
	expect(JSON.parse(rows.results[0]?.payload ?? "{}")).toMatchObject({
		trigger: "daily",
		depth: "quick",
		repos: ["nocoo/app"],
	});
	expect((await readSchedules(s.db, snap.account_id))[0]).toMatchObject({
		nextAt: "2026-09-28T00:00:00.000Z",
		lastError: null,
	});
});
it("records empty selections, defers active runs and never starts disabled tasks", async () => {
	const s = await setup();
	await saveSchedule(
		s.db,
		snap.account_id,
		"daily",
		{ enabled: true, time: "08:00", weekday: 0, scope: "starred" },
		"2026-09-26T00:01:00.000Z",
	);
	await scheduleRefreshes(s.raw, now);
	expect((await readSchedules(s.db, snap.account_id))[0]?.lastError).toBe(
		"no_starred_repositories",
	);
	await saveSchedule(
		s.db,
		snap.account_id,
		"weekly",
		{ enabled: true, time: "08:00", weekday: 0, scope: "all" },
		"2026-09-26T00:01:00.000Z",
	);
	await scheduleRefreshes(s.raw, now);
	expect(
		(await s.db.prepare("SELECT payload FROM factory_runs").first<{ payload: string }>())?.payload,
	).toContain('"depth":"deep"');
	await saveSchedule(
		s.db,
		snap.account_id,
		"daily",
		{ enabled: true, time: "08:01", weekday: 0, scope: "all" },
		now,
	);
	await scheduleRefreshes(s.raw, "2026-09-27T00:02:00.000Z");
	expect((await readSchedules(s.db, snap.account_id))[0]?.lastError).toBe("account_conflict");
	await saveSchedule(
		s.db,
		snap.account_id,
		"daily",
		{ enabled: false, time: "08:00", weekday: 0, scope: "starred" },
		now,
	);
	await scheduleRefreshes(s.raw, "2026-09-29T00:00:00.000Z");
	expect((await readSchedules(s.db, snap.account_id))[0]?.enabled).toBe(false);
});

it("refreshes starred repository pages even when statistics are disabled, and retries missing catalogs", async () => {
	const s = await setup();
	await s.db
		.prepare("INSERT INTO repo_stars(account_id,repo) VALUES(?,?)")
		.bind(snap.account_id, "nocoo/app")
		.run();
	await s.db
		.prepare("INSERT INTO repo_statistics(account_id,repo,enabled) VALUES(?,?,0)")
		.bind(snap.account_id, "nocoo/app")
		.run();
	await saveSchedule(
		s.db,
		snap.account_id,
		"daily",
		{ enabled: true, time: "08:00", weekday: 0, scope: "starred" },
		"2026-09-26T00:01:00.000Z",
	);
	await scheduleRefreshes(s.raw, now);
	const row = await s.db.prepare("SELECT payload FROM factory_runs").first<{ payload: string }>();
	expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({ repos: [], siteRepos: ["nocoo/app"] });
	const missing = await setup();
	await missing.db.prepare("DELETE FROM snapshots WHERE kind='factory'").run();
	await saveSchedule(
		missing.db,
		snap.account_id,
		"weekly",
		{ enabled: true, time: "08:00", weekday: 0, scope: "all" },
		"2026-09-26T00:01:00.000Z",
	);
	await scheduleRefreshes(missing.raw, now);
	expect((await readSchedules(missing.db, snap.account_id))[1]?.lastError).toBe(
		"catalog_incomplete",
	);
});
