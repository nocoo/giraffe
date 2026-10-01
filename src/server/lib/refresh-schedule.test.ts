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
	const steps = JSON.parse(rows.results[0]?.payload ?? "{}").steps as {
		resource?: string;
		kind: string;
	}[];
	expect(steps.slice(0, 2).map((step) => step.resource)).toEqual(["repos", "notifications"]);
	expect(steps.some((step) => step.resource === "insights")).toBe(true);
	expect(steps.filter((step) => step.resource === "repo:nocoo/app:issues")).toHaveLength(1);
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

it("refreshes disabled-statistics stars and prepares missing catalogues before scheduled refresh", async () => {
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
	expect((await readSchedules(missing.db, snap.account_id))[1]?.lastError).toBe("catalog_pending");
	const preparation = await missing.db
		.prepare("SELECT payload FROM factory_runs")
		.first<{ payload: string }>();
	expect(JSON.parse(preparation?.payload ?? "{}")).toMatchObject({
		mode: "catalog",
		trigger: "weekly",
	});
});

it("prepares stale catalogues once without advancing or duplicating the scheduled occurrence", async () => {
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
		now,
	);
	const later = "2026-09-28T00:01:00.000Z";
	await scheduleRefreshes(s.raw, later);
	await scheduleRefreshes(s.raw, later);
	const rows = await s.db.prepare("SELECT payload FROM factory_runs").all<{ payload: string }>();
	expect(rows.results).toHaveLength(1);
	expect(JSON.parse(rows.results[0]?.payload ?? "{}")).toMatchObject({ mode: "catalog" });
	expect((await readSchedules(s.db, snap.account_id))[0]).toMatchObject({
		nextAt: "2026-09-28T00:00:00.000Z",
		lastError: "catalog_pending",
	});
	await s.db
		.prepare(
			"UPDATE factory_runs SET status='failed',payload=json_set(payload,'$.status','failed')",
		)
		.run();
	await scheduleRefreshes(s.raw, "2026-09-28T00:03:00.000Z");
	expect((await readSchedules(s.db, snap.account_id))[0]).toMatchObject({
		nextAt: "2026-09-29T00:00:00.000Z",
		lastError: "catalog_incomplete",
	});
	await saveSchedule(
		s.db,
		snap.account_id,
		"daily",
		{ enabled: true, time: "08:00", weekday: 0, scope: "starred" },
		now,
	);
	await s.db.prepare("UPDATE factory_runs SET status='completed'").run();
	await s.db.batch(replaceSnapshotStmts(s.db, snap.account_id, "factory", snap, later));
	await scheduleRefreshes(s.raw, "2026-09-28T00:03:00.000Z");
	const ready = await s.db
		.prepare("SELECT payload FROM factory_runs WHERE status='running'")
		.first<{ payload: string }>();
	expect(JSON.parse(ready?.payload ?? "{}")).toMatchObject({
		mode: "refresh",
		trigger: "daily",
		depth: "quick",
	});
	expect((await readSchedules(s.db, snap.account_id))[0]?.nextAt).toBe("2026-09-29T00:00:00.000Z");
});

it("schedules catalogue discovery daily without requiring existing catalogues or stars", async () => {
	const s = await setup();
	await s.db.prepare("DELETE FROM snapshots").run();
	expect(
		(await readSchedules(s.db, snap.account_id)).find((row) => row.kind === "catalog"),
	).toMatchObject({ enabled: false, scope: "all" });
	await saveSchedule(
		s.db,
		snap.account_id,
		"catalog",
		{ enabled: true, time: "07:00", weekday: 0, scope: "all" },
		"2026-09-26T00:01:00.000Z",
	);
	await Promise.all([scheduleRefreshes(s.raw, now), scheduleRefreshes(s.raw, now)]);
	const rows = await s.db.prepare("SELECT payload FROM factory_runs").all<{ payload: string }>();
	expect(rows.results).toHaveLength(1);
	const run = JSON.parse(rows.results[0]?.payload ?? "{}");
	expect(run).toMatchObject({
		mode: "catalog",
		trigger: "daily",
		repos: [],
		schedule: { kind: "catalog", dueAt: "2026-09-26T23:00:00.000Z" },
	});
	expect(run.steps.map((step: { kind: string }) => step.kind)).toEqual([
		"inventory",
		"snapshot",
		"restore",
		"publish",
	]);
	expect(
		(await readSchedules(s.db, snap.account_id)).find((row) => row.kind === "catalog"),
	).toMatchObject({ nextAt: "2026-09-27T23:00:00.000Z", lastRunId: run.id, lastError: null });
	await saveSchedule(
		s.db,
		snap.account_id,
		"catalog",
		{ enabled: false, time: "07:00", weekday: 0, scope: "all" },
		now,
	);
	await scheduleRefreshes(s.raw, "2026-09-29T00:00:00.000Z");
	expect((await s.db.prepare("SELECT id FROM factory_runs").all()).results).toHaveLength(1);
});
