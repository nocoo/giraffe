import { afterEach, expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { missedSlotFixture } from "../../../../../tests/fixtures/missed-slots";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { createDb } from "./db/d1";
import { replaceSnapshotStmts } from "./db/snapshots";
import { startRefresh } from "./factory-start";
import { nextScheduleAt, readSchedules, saveSchedule, scheduleRefreshes } from "./refresh-schedule";

const snap = factoryFixture();
const now = "2026-09-27T00:00:00.000Z";
afterEach(() => vi.useRealTimers());
async function setup() {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?,?,?,?,?)",
		)
		.bind(snap.account_id, "nocoo", "fake", "fake", now, now)
		.run();
	await db.batch(await replaceSnapshotStmts(db, snap.account_id, "factory", snap, now));
	await db.batch(
		await replaceSnapshotStmts(
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
		(
			await s.db
				.prepare("SELECT payload FROM factory_runs WHERE status='running'")
				.first<{ payload: string }>()
		)?.payload,
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
	expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({
		repos: ["nocoo/app"],
		siteRepos: ["nocoo/app"],
	});
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
		lastError: "catalog_preparation_failed",
	});
	await saveSchedule(
		s.db,
		snap.account_id,
		"daily",
		{ enabled: true, time: "08:00", weekday: 0, scope: "starred" },
		now,
	);
	await s.db.batch(
		await replaceSnapshotStmts(
			s.db,
			snap.account_id,
			"factory",
			{ ...snap, fetched_at: later },
			later,
		),
	);
	await scheduleRefreshes(s.raw, "2026-09-28T00:03:00.000Z");
	expect(
		(await s.db.prepare("SELECT id FROM factory_runs WHERE status='running'").all()).results,
	).toEqual([]);
	const settled = await s.db
		.prepare("SELECT payload FROM factory_runs WHERE request_key=?")
		.bind("daily:2026-09-28T00:00:00.000Z")
		.first<{ payload: string }>();
	expect(JSON.parse(settled?.payload ?? "{}")).toMatchObject({
		status: "failed",
		error: "catalog_preparation_failed",
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

it("records every prior-day slot separately before starting the current occurrence", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
	const s = await setup();
	await saveSchedule(
		s.db,
		snap.account_id,
		"catalog",
		{ enabled: true, time: "08:00", weekday: 0, scope: "all" },
		"2026-09-24T00:01:00.000Z",
	);
	await Promise.all([
		scheduleRefreshes(s.raw, new Date().toISOString()),
		scheduleRefreshes(s.raw, new Date().toISOString()),
	]);
	const rows = (
		await s.db.prepare("SELECT payload FROM factory_runs").all<{ payload: string }>()
	).results.map((row) => JSON.parse(row.payload));
	expect(rows).toHaveLength(3);
	const missed = rows.filter((run) => run.error === "scheduled_slot_missed");
	expect(missed.map((run) => run.schedule.dueAt).sort()).toEqual([
		"2026-09-25T00:00:00.000Z",
		"2026-09-26T00:00:00.000Z",
	]);
	for (const run of missed)
		expect(run.missedSlots).toEqual({
			firstDueAt: run.schedule.dueAt,
			lastDueAt: run.schedule.dueAt,
			count: 1,
		});
	expect(rows.find((run) => run.status === "running")?.schedule.dueAt).toBe(now);
	expect((await readSchedules(s.db, snap.account_id))[2]).toMatchObject({
		nextAt: "2026-09-28T00:00:00.000Z",
		lastError: "scheduled_slot_missed",
	});
	await scheduleRefreshes(s.raw, new Date().toISOString());
	expect((await s.db.prepare("SELECT id FROM factory_runs").all()).results).toHaveLength(3);
});

it.each([
	"2026-10-23T00:00:00+08:00",
	"2026-10-23T07:59:59+08:00",
	"2026-10-23T08:00:00+08:00",
	"2026-10-23T23:59:59+08:00",
])("L2 missed-slot fixture stays correct at Beijing time %s", async (clock) => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(clock));
	const { raw, db } = await setup();
	const fixture = missedSlotFixture(new Date().toISOString());
	await db
		.prepare(
			"INSERT INTO catalog_refresh_schedules(account_id,kind,enabled,time,weekday,scope,next_at) VALUES(?,'catalog',1,?,0,'all',?)",
		)
		.bind(snap.account_id, fixture.time, fixture.due)
		.run();
	await scheduleRefreshes(raw, new Date().toISOString());
	const rows = await db.prepare("SELECT payload FROM factory_runs").all<{ payload: string }>();
	const runs = rows.results.map((row) => JSON.parse(row.payload));
	expect(runs).toHaveLength(4);
	expect(
		runs
			.filter((run) => run.error === "scheduled_slot_missed")
			.map((run) => run.requestKey)
			.sort(),
	).toEqual([
		"catalog:2026-10-19T16:00:00.000Z",
		"catalog:2026-10-20T16:00:00.000Z",
		"catalog:2026-10-21T16:00:00.000Z",
	]);
	expect(runs.find((run) => run.status === "running")?.requestKey).toBe(
		"catalog:2026-10-22T16:00:00.000Z",
	);
	const before = rows.results.map((row) => row.payload).sort();
	await scheduleRefreshes(raw, new Date().toISOString());
	expect(
		(await db.prepare("SELECT payload FROM factory_runs").all<{ payload: string }>()).results
			.map((row) => row.payload)
			.sort(),
	).toEqual(before);
});

it("expires a scheduled paused lock before planning and retains the safe timeout in settings", async () => {
	const s = await setup();
	await saveSchedule(
		s.db,
		snap.account_id,
		"catalog",
		{ enabled: true, time: "08:00", weekday: 0, scope: "all" },
		"2026-09-26T00:01:00.000Z",
	);
	await scheduleRefreshes(s.raw, now);
	await s.db
		.prepare(
			"UPDATE factory_runs SET status='paused',payload=json_set(payload,'$.status','paused')",
		)
		.run();
	await scheduleRefreshes(s.raw, "2026-09-27T00:30:00.000Z");
	expect((await readSchedules(s.db, snap.account_id))[2]?.lastError).toBe("run_timed_out");
	const rows = await s.db
		.prepare("SELECT status,lease_token,lease_until,payload FROM factory_runs")
		.all();
	expect(rows.results[0]).toMatchObject({ status: "failed", lease_token: null, lease_until: null });
});

it("does not count an accepted occurrence as missed after a crash before schedule acknowledgement", async () => {
	const s = await setup();
	await saveSchedule(
		s.db,
		snap.account_id,
		"catalog",
		{ enabled: true, time: "08:00", weekday: 0, scope: "all" },
		"2026-09-26T00:01:00.000Z",
	);
	await scheduleRefreshes(s.raw, now);
	await s.db.prepare("UPDATE catalog_refresh_schedules SET next_at=?").bind(now).run();
	await scheduleRefreshes(s.raw, "2026-09-29T00:00:00.000Z");
	const rows = (
		await s.db.prepare("SELECT payload FROM factory_runs").all<{ payload: string }>()
	).results.map((row) => JSON.parse(row.payload));
	expect(rows.find((run) => run.missedSlots)?.missedSlots).toEqual({
		firstDueAt: "2026-09-28T00:00:00.000Z",
		lastDueAt: "2026-09-28T00:00:00.000Z",
		count: 1,
	});
	expect(rows.filter((run) => run.status === "running")).toHaveLength(1);
});

it("never advances past missed slots if their durable audit transaction fails", async () => {
	const s = await setup();
	await saveSchedule(
		s.db,
		snap.account_id,
		"catalog",
		{ enabled: true, time: "08:00", weekday: 0, scope: "all" },
		"2026-09-24T00:01:00.000Z",
	);
	const batch = s.raw.batch.bind(s.raw);
	vi.spyOn(s.raw, "batch").mockImplementationOnce((writes) =>
		batch([
			...writes,
			s.raw.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)",
			),
		]),
	);
	await scheduleRefreshes(s.raw, now);
	expect((await readSchedules(s.db, snap.account_id))[2]).toMatchObject({
		nextAt: "2026-09-25T00:00:00.000Z",
		lastError: "db_error",
	});
	expect((await s.db.prepare("SELECT id FROM factory_runs").all()).results).toHaveLength(0);
	await scheduleRefreshes(s.raw, now);
	expect((await s.db.prepare("SELECT id FROM factory_runs").all()).results).toHaveLength(3);
});

it.each(["missed", "empty"] as const)(
	"does not replace a concurrently accepted %s occurrence with an audit",
	async (scenario) => {
		const s = await setup();
		const kind = scenario === "missed" ? "catalog" : "daily";
		const due = scenario === "missed" ? "2026-09-26T00:00:00.000Z" : now;
		await saveSchedule(
			s.db,
			snap.account_id,
			kind,
			{ enabled: true, time: "08:00", weekday: 0, scope: kind === "catalog" ? "all" : "starred" },
			new Date(Date.parse(due) - 1).toISOString(),
		);
		const batch = s.raw.batch.bind(s.raw);
		let acceptedId = "";
		vi.spyOn(s.raw, "batch").mockImplementationOnce(async (writes) => {
			const accepted = await startRefresh(
				createDb(s.raw),
				{ id: snap.account_id, login: "nocoo" },
				{
					account_id: snap.account_id,
					requestKey: `${kind}:${due}`,
					mode: kind === "catalog" ? "catalog" : "refresh",
					depth: "quick",
					scope: "all",
				},
				due,
				"daily",
				{ kind, dueAt: due },
			);
			acceptedId = accepted.id;
			return batch(writes);
		});
		await scheduleRefreshes(s.raw, now);
		const rows = await s.db
			.prepare("SELECT id,status FROM factory_runs WHERE request_key=?")
			.bind(`${kind}:${due}`)
			.all();
		expect(rows.results).toEqual([{ id: acceptedId, status: "running" }]);
		expect(
			(
				await s.db
					.prepare(
						"SELECT id FROM factory_runs WHERE json_extract(payload,'$.error')='scheduled_slot_missed'",
					)
					.all()
			).results,
		).toEqual([]);
	},
);

it("keeps the oldest weekly occurrence pending and preserves its identity after timeout", async () => {
	const s = await setup();
	await saveSchedule(
		s.db,
		snap.account_id,
		"weekly",
		{ enabled: true, time: "08:00", weekday: 0, scope: "all" },
		"2026-09-05T00:01:00.000Z",
	);
	await scheduleRefreshes(s.raw, now);
	const first = await s.db
		.prepare("SELECT id,payload FROM factory_runs")
		.first<{ id: string; payload: string }>();
	expect(JSON.parse(first?.payload ?? "{}").schedule.dueAt).toBe("2026-09-06T00:00:00.000Z");
	expect((await readSchedules(s.db, snap.account_id))[1]?.nextAt).toBe("2026-09-13T00:00:00.000Z");
	await scheduleRefreshes(s.raw, "2026-10-18T00:00:00.000Z");
	const old = await s.db
		.prepare("SELECT payload FROM factory_runs WHERE id=?")
		.bind(first?.id)
		.first<{ payload: string }>();
	expect(JSON.parse(old?.payload ?? "{}")).toMatchObject({
		error: "run_timed_out",
		schedule: { kind: "weekly", dueAt: "2026-09-06T00:00:00.000Z" },
	});
	expect(
		(
			await s.db
				.prepare("SELECT id FROM factory_runs WHERE request_key=?")
				.bind("weekly:2026-09-06T00:00:00.000Z")
				.all()
		).results,
	).toHaveLength(1);
});
