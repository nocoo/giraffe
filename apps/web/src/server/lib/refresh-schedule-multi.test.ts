import { expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { createDb } from "./db/d1";
import { replaceSnapshotStmts } from "./db/snapshots";
import { nextScheduleAt, readSchedules, saveSchedule, scheduleRefreshes } from "./refresh-schedule";

const account = "a".repeat(21);
const now = "2026-09-27T12:00:00.000Z";
async function fixture() {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?,'fake','fake',?,?)",
		)
		.bind(account, "nocoo", now, now)
		.run();
	const snap = factoryFixture();
	await db.batch(await replaceSnapshotStmts(db, account, "factory", snap, now));
	await db.batch(
		await replaceSnapshotStmts(
			db,
			account,
			"repos",
			{ truncated: false, repos: snap.repos.map((repo) => ({ name_with_owner: repo.name })) },
			now,
		),
	);
	return { raw, db };
}
const config = {
	enabled: true,
	time: "05:30",
	times: ["19:30", "05:30", "05:30"],
	weekday: 0,
	scope: "all" as const,
};

it("selects the next sorted slot for daily, weekly and catalogue schedules", async () => {
	const s = await fixture();
	for (const kind of ["daily", "weekly", "catalog"] as const) {
		await saveSchedule(s.db, account, kind, config, "2026-09-26T22:00:00.000Z");
		const schedule = (await readSchedules(s.db, account)).find((row) => row.kind === kind);
		expect(schedule).toMatchObject({
			time: "05:30",
			times: ["05:30", "19:30"],
			nextAt: "2026-09-27T11:30:00.000Z",
		});
	}
});

it("advances weekly times on the same weekday before moving to the next week", () => {
	expect(nextScheduleAt("weekly", ["05:30", "19:30"], 0, "2026-09-26T21:30:00.000Z")).toBe(
		"2026-09-27T11:30:00.000Z",
	);
	expect(nextScheduleAt("weekly", ["05:30", "19:30"], 0, "2026-09-27T11:30:00.000Z")).toBe(
		"2026-10-03T21:30:00.000Z",
	);
	expect(nextScheduleAt("daily", ["00:00", "23:59"], 0, "2026-12-31T15:59:00.000Z")).toBe(
		"2026-12-31T16:00:00.000Z",
	);
});

it.each(["daily", "catalog", "weekly"] as const)(
	"coalesces every missed %s slot once under concurrent ticks",
	async (kind) => {
		const s = await fixture();
		await s.db
			.prepare("INSERT INTO repo_stars(account_id,repo) VALUES(?,'nocoo/app')")
			.bind(account)
			.run();
		await saveSchedule(
			s.db,
			account,
			kind,
			{ ...config, scope: kind === "daily" ? "starred" : "all" },
			"2026-09-19T22:00:00.000Z",
		);
		await Promise.all([scheduleRefreshes(s.raw, now), scheduleRefreshes(s.raw, now)]);
		const rows = (
			await s.db.prepare("SELECT payload FROM factory_runs").all<{ payload: string }>()
		).results.map((row) => JSON.parse(row.payload));
		const missed = rows.find((run) => run.error === "scheduled_slots_missed");
		expect(rows).toHaveLength(2);
		expect(rows.find((run) => run.status === "running")?.schedule.dueAt).toBe(
			"2026-09-27T11:30:00.000Z",
		);
		expect(missed?.missedSlots).toEqual({
			firstDueAt: "2026-09-20T11:30:00.000Z",
			lastDueAt: "2026-09-26T21:30:00.000Z",
			count: kind === "weekly" ? 2 : 14,
		});
		expect((await readSchedules(s.db, account)).find((row) => row.kind === kind)?.nextAt).toBe(
			kind === "weekly" ? "2026-10-03T21:30:00.000Z" : "2026-09-27T21:30:00.000Z",
		);
		await scheduleRefreshes(s.raw, now);
		expect((await s.db.prepare("SELECT id FROM factory_runs").all()).results).toHaveLength(
			rows.length,
		);
	},
);

it("recovers an accepted slot without marking it missed and defers a close slot behind its run", async () => {
	const s = await fixture();
	await saveSchedule(
		s.db,
		account,
		"catalog",
		{ ...config, time: "19:30", times: ["19:30", "19:31"] },
		"2026-09-27T11:29:00.000Z",
	);
	await scheduleRefreshes(s.raw, "2026-09-27T11:30:00.000Z");
	await s.db
		.prepare("UPDATE catalog_refresh_schedules SET next_at='2026-09-27T11:30:00.000Z'")
		.run();
	await scheduleRefreshes(s.raw, "2026-09-27T11:31:00.000Z");
	expect((await s.db.prepare("SELECT id FROM factory_runs").all()).results).toHaveLength(1);
	expect((await readSchedules(s.db, account))[2]).toMatchObject({
		nextAt: "2026-09-27T11:31:00.000Z",
		lastError: "account_conflict",
	});
	await scheduleRefreshes(s.raw, "2026-09-27T11:31:00.000Z");
	expect((await s.db.prepare("SELECT id FROM factory_runs").all()).results).toHaveLength(1);
});

it("rolls back both old columns and slot lists if saving either half fails", async () => {
	const s = await fixture();
	await saveSchedule(s.db, account, "catalog", { ...config, times: ["05:30"] }, now);
	const before = await readSchedules(s.db, account);
	await s.db
		.prepare(
			"CREATE TRIGGER fail_multi BEFORE UPDATE ON refresh_schedule_times WHEN json_array_length(NEW.times)>1 BEGIN SELECT RAISE(ABORT,'test-only rejection'); END",
		)
		.run();
	await expect(
		saveSchedule(s.db, account, "catalog", { ...config, enabled: false }, now),
	).rejects.toMatchObject({ code: "db_error" });
	expect(await readSchedules(s.db, account)).toEqual(before);
});

it("does not record or advance stale missed slots after the user changes the schedule", async () => {
	const s = await fixture();
	await saveSchedule(s.db, account, "catalog", config, "2026-09-19T22:00:00.000Z");
	const batch = s.raw.batch.bind(s.raw);
	vi.spyOn(s.raw, "batch").mockImplementationOnce(async (writes) => {
		await saveSchedule(
			s.db,
			account,
			"catalog",
			{ ...config, time: "21:30", times: ["21:30", "23:00"] },
			now,
		);
		return batch(writes);
	});
	await scheduleRefreshes(s.raw, now);
	expect((await s.db.prepare("SELECT id FROM factory_runs").all()).results).toEqual([]);
	expect((await readSchedules(s.db, account))[2]).toMatchObject({
		times: ["21:30", "23:00"],
		nextAt: "2026-09-27T13:30:00.000Z",
		lastError: null,
	});
});
