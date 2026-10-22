import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { FactoryRun } from "../../apps/web/src/lib/factory-run";
import { factoryFixture } from "../fixtures/factory-snapshot";
import { revisionFixture } from "../fixtures/revision";
import { sqliteFixture } from "../fixtures/sqlite";

const historicalSha = execFileSync("git", ["rev-parse", "ac2d1e3"], { encoding: "utf8" }).trim();
const revision = revisionFixture(historicalSha);
const originalFetch = globalThis.fetch;
const denyNetwork = () => {
	throw new Error("historical schedule replay forbids network");
};
globalThis.fetch = Object.assign(denyNetwork, { preconnect: denyNetwork });
const OriginalDate = globalThis.Date;
let clock = "2026-10-16T11:30:00.000Z";
globalThis.Date = class extends OriginalDate {
	constructor(value: string | number = clock) {
		super(value);
	}
	static now() {
		return OriginalDate.parse(clock);
	}
} as DateConstructor;

try {
	const scheduler = await revision.load<
		typeof import("../../apps/web/src/server/lib/refresh-schedule")
	>("apps/web/src/server/lib/refresh-schedule.ts");
	const historicalRun = await revision.load<typeof import("../../apps/web/src/lib/factory-run")>(
		"apps/web/src/lib/factory-run.ts",
	);
	const raw = sqliteFixture();
	const account = "a".repeat(21);
	const due = clock;
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake',?,?)",
		)
		.bind(account, due, due)
		.run();
	await raw
		.prepare("INSERT INTO repo_stars(account_id,repo) VALUES(?,'nocoo/app')")
		.bind(account)
		.run();
	await raw
		.prepare("INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES(?,'repos',?,?)")
		.bind(
			account,
			JSON.stringify({
				repos: [{ name_with_owner: "nocoo/app", is_fork: false, is_archived: false }],
				fetched_at: due,
				truncated: false,
			}),
			due,
		)
		.run();
	for (const [kind, slot, weekday, scope, nextAt] of [
		["daily", "19:30", 0, "starred", due],
		["weekly", "04:00", 0, "all", "2026-10-17T20:00:00.000Z"],
	] as const)
		await raw
			.prepare(
				"INSERT INTO refresh_schedules(account_id,kind,enabled,time,weekday,scope,next_at) VALUES(?,?,1,?,?,?,?)",
			)
			.bind(account, kind, slot, weekday, scope, nextAt)
			.run();
	const catalog = historicalRun.makeRun(
		"7c676d29",
		account,
		"nocoo",
		`daily:${due}:catalog`,
		"catalog",
		[],
		due,
	);
	Object.assign(catalog, { trigger: "daily", schedule: { kind: "daily", dueAt: due } });
	await raw
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,?,?,'running',?,?,?,?)",
		)
		.bind(catalog.id, account, catalog.requestKey, JSON.stringify(catalog), due, due, due)
		.run();
	const runs = async () =>
		(
			await raw
				.prepare("SELECT payload FROM factory_runs ORDER BY created_at")
				.all<{ payload: string }>()
		).results.map((row) => JSON.parse(row.payload) as FactoryRun);
	const tick = async (at: string) => {
		clock = at;
		await scheduler.scheduleRefreshes(raw, at);
	};
	for (const at of [
		"2026-10-16T11:31:00.000Z",
		"2026-10-17T11:30:00.000Z",
		"2026-10-17T20:00:00.000Z",
		"2026-10-18T11:30:00.000Z",
	])
		await tick(at);
	assert.equal(
		(await runs()).length,
		1,
		"healthy historical cron cannot admit later work behind injected active catalog",
	);
	const complete = async (run: FactoryRun, at: string) => {
		run.status = "completed";
		run.finishedAt = at;
		await raw
			.prepare("UPDATE factory_runs SET status='completed',payload=?,updated_at=? WHERE id=?")
			.bind(JSON.stringify(run), at, run.id)
			.run();
	};
	const releasedAt = "2026-10-18T12:08:00.000Z";
	await complete(catalog, releasedAt);
	const publication = { ...factoryFixture(), fetched_at: releasedAt };
	await raw
		.prepare("INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES(?,'factory',?,?)")
		.bind(account, JSON.stringify(publication), releasedAt)
		.run();
	await tick("2026-10-18T12:09:00.000Z");
	const daily = (await runs()).find((run) => run.requestKey === `daily:${due}`);
	assert.ok(daily);
	assert.equal(daily.startedAt, clock);
	assert.equal(
		(
			await raw
				.prepare("SELECT next_at FROM refresh_schedules WHERE account_id=? AND kind='daily'")
				.bind(account)
				.first<{ next_at: string }>()
		)?.next_at,
		"2026-10-19T11:30:00.000Z",
	);
	await complete(daily, "2026-10-18T12:48:00.000Z");
	await tick("2026-10-18T12:49:00.000Z");
	const finalRuns = await runs();
	const weekly = finalRuns.find((run) => run.trigger === "weekly");
	assert.ok(weekly);
	assert.equal(weekly.startedAt, clock);
	assert.equal(finalRuns.length, 3);
	for (const skipped of ["2026-10-17T11:30:00.000Z", "2026-10-18T11:30:00.000Z"])
		assert.equal(
			finalRuns.some((run) => run.requestKey === `daily:${skipped}`),
			false,
		);
	console.log(
		JSON.stringify({
			historicalSha,
			catalogRelease: releasedAt,
			dailyStart: daily.startedAt,
			dailyDue: due,
			weeklyStart: weekly.startedAt,
			missingDailyDates: ["2026-10-17", "2026-10-18"],
			boundary:
				"injected stall and completion times reproduce scheduling consequences only; exact production stall cause is not established",
		}),
	);
} finally {
	globalThis.fetch = originalFetch;
	globalThis.Date = OriginalDate;
	revision.close();
}
