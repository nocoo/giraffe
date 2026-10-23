import { afterEach, expect, it, vi } from "vitest";
import { rawRepo } from "../../../../../tests/fixtures/factory";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { type FactoryRun, makeRun } from "../../lib/factory-run";
import type { ScheduleKind } from "../../lib/refresh-schedule";
import type { Env } from "../env";
import { createApp } from "../index";
import { createApiToken } from "./api-tokens";
import { createDb } from "./db/d1";
import { claimRun, getRun, saveRun, startRun } from "./db/factory-runs";
import { replaceSnapshotStmts } from "./db/snapshots";
import { consumeFactory, handoffAccount } from "./factory-dispatch";
import { executeRunPage } from "./factory-execute";
import { startRefresh } from "./factory-start";
import { readSchedules, saveSchedule, scheduleRefreshes } from "./refresh-schedule";
import { encryptToken, parseKeyBytes } from "./token-crypto";

const account = "a".repeat(21);
const now = "2026-10-18T12:08:00.000Z";
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
async function setup(at = now) {
	vi.useFakeTimers();
	vi.setSystemTime(at);
	const raw = sqliteFixture();
	const db = () => createDb(raw);
	await db()
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake',?,?)",
		)
		.bind(account, at, at)
		.run();
	await db()
		.prepare("INSERT INTO repo_stars(account_id,repo) VALUES(?,'nocoo/app')")
		.bind(account)
		.run();
	async function catalog(time = at) {
		const saved = db();
		await saved.batch(
			await replaceSnapshotStmts(
				saved,
				account,
				"factory",
				{ ...factoryFixture(), fetched_at: time },
				time,
			),
		);
		await saved.batch(
			await replaceSnapshotStmts(
				saved,
				account,
				"repos",
				{ truncated: false, repos: [{ name_with_owner: "nocoo/app" }] },
				time,
			),
		);
	}
	await catalog();
	async function schedule(kind: ScheduleKind, due: string, times = ["19:30"]) {
		await saveSchedule(
			db(),
			account,
			kind,
			{
				enabled: true,
				time: times[0] as string,
				times,
				weekday: 0,
				scope: kind === "daily" ? "starred" : "all",
			},
			new Date(Date.parse(due) - 1).toISOString(),
		);
	}
	async function runs() {
		return (
			await db()
				.prepare("SELECT payload FROM factory_runs ORDER BY created_at,id")
				.all<{ payload: string }>()
		).results.map((row) => JSON.parse(row.payload) as FactoryRun);
	}
	return { raw, db, catalog, schedule, runs };
}

it("rechecks a catalog completed between readiness and idempotency reads", async () => {
	const fixture = await setup();
	const due = "2026-10-18T11:30:00.000Z";
	await fixture.catalog("2026-10-16T00:00:00.000Z");
	await fixture.schedule("daily", due);
	await scheduleRefreshes(fixture.raw, now);
	const preparation = (await fixture.runs())[0];
	if (!preparation) throw new Error("missing catalog preparation");
	const prepare = fixture.raw.prepare.bind(fixture.raw);
	let released = false;
	const intercept = vi.spyOn(fixture.raw, "prepare").mockImplementation((sql) => {
		const statement = prepare(sql);
		if (sql !== "SELECT id,status FROM factory_runs WHERE account_id=? AND request_key=?")
			return statement;
		return {
			...statement,
			bind: (...values: unknown[]) => {
				const bound = statement.bind(...values);
				return {
					...bound,
					first: async <Row>() => {
						if (!released && values[1] === `${preparation.requestKey}`) {
							released = true;
							await fixture.catalog();
							await prepare("UPDATE factory_runs SET status='completed',payload=? WHERE id=?")
								.bind(
									JSON.stringify({ ...preparation, status: "completed", finishedAt: now }),
									preparation.id,
								)
								.run();
						}
						return bound.first<Row>();
					},
				} as D1PreparedStatement;
			},
		} as D1PreparedStatement;
	});
	try {
		await scheduleRefreshes(fixture.raw, now);
		await scheduleRefreshes(fixture.raw, now);
		expect(released).toBe(true);
		expect((await fixture.runs()).find((run) => run.requestKey === `daily:${due}`)).toMatchObject({
			status: "running",
			mode: "refresh",
		});
		expect((await fixture.runs()).some((run) => run.error === "catalog_preparation_failed")).toBe(
			false,
		);
	} finally {
		intercept.mockRestore();
	}
});

it("records October 16 and 17 individually and starts the current-day daily before an older weekly", async () => {
	const s = await setup();
	await s.schedule("daily", "2026-10-16T11:30:00.000Z");
	await s.schedule("weekly", "2026-10-17T20:00:00.000Z", ["04:00"]);
	await Promise.all([scheduleRefreshes(s.raw, now), scheduleRefreshes(s.raw, now)]);
	const runs = await s.runs();
	expect(
		runs
			.filter((run) => run.error === "scheduled_slot_missed")
			.map((run) => run.schedule?.dueAt)
			.sort(),
	).toEqual(["2026-10-16T11:30:00.000Z", "2026-10-17T11:30:00.000Z"]);
	expect(runs.find((run) => run.status === "running")).toMatchObject({
		mode: "refresh",
		schedule: { kind: "daily", dueAt: "2026-10-18T11:30:00.000Z" },
		startedAt: now,
	});
	expect((await readSchedules(s.db(), account))[0]?.nextAt).toBe("2026-10-19T11:30:00.000Z");
});

it("keeps multiple elapsed daily slots on the same Beijing day rather than coalescing them", async () => {
	const s = await setup();
	await s.schedule("daily", "2026-10-17T20:00:00.000Z", ["04:00", "19:30"]);
	await scheduleRefreshes(s.raw, now);
	expect((await s.runs()).find((run) => run.status === "running")?.schedule?.dueAt).toBe(
		"2026-10-17T20:00:00.000Z",
	);
	expect((await readSchedules(s.db(), account))[0]?.nextAt).toBe("2026-10-18T11:30:00.000Z");
});

it.each(["daily", "weekly", "catalog"] as const)(
	"hands off a completed %s immediately through Queue while cron races",
	async (kind) => {
		const s = await setup();
		await s.schedule("daily", "2026-10-18T11:30:00.000Z");
		const predecessor = makeRun(
			"predecessor",
			account,
			"nocoo",
			"manual",
			kind === "catalog" ? "catalog" : "refresh",
			[],
			now,
		);
		predecessor.steps = [];
		await startRun(s.db(), predecessor);
		await s
			.db()
			.prepare("INSERT INTO factory_repo_state(account_id,repo,payload) VALUES(?,'nocoo/app',?)")
			.bind(
				account,
				JSON.stringify({
					repo: "nocoo/app",
					status: "success",
					nextAllowedAt: "2026-10-18T12:23:00.000Z",
				}),
			)
			.run();
		const send = vi.fn();
		const env = { DB: s.raw, FACTORY_QUEUE: { send } } as unknown as Env;
		const ack = vi.fn(),
			retry = vi.fn();
		await Promise.all([
			consumeFactory(
				{
					messages: [{ body: { id: predecessor.id }, ack, retry }],
				} as unknown as MessageBatch<unknown>,
				env,
			),
			scheduleRefreshes(s.raw, now),
		]);
		expect(retry).not.toHaveBeenCalled();
		const next = (await s.runs()).filter(
			(run) => run.requestKey === "daily:2026-10-18T11:30:00.000Z",
		);
		expect(next).toHaveLength(1);
		expect(next[0]).toMatchObject({ status: "running", startedAt: now });
		expect(next[0]?.steps.some((step) => step.error === "repository_cooldown")).toBe(false);
		expect(send).toHaveBeenCalledWith({ id: next[0]?.id }, { delaySeconds: 0 });
	},
);

it("gives equal-slot weekly priority and never cancels it when daily becomes due", async () => {
	const s = await setup();
	await s.schedule("daily", "2026-10-18T11:30:00.000Z");
	await s.schedule("weekly", "2026-10-18T11:30:00.000Z");
	await Promise.all([scheduleRefreshes(s.raw, now), scheduleRefreshes(s.raw, now)]);
	expect((await s.runs()).filter((run) => run.status === "running")).toEqual([
		expect.objectContaining({ schedule: { kind: "weekly", dueAt: "2026-10-18T11:30:00.000Z" } }),
	]);
	expect((await readSchedules(s.db(), account))[0]).toMatchObject({
		nextAt: "2026-10-18T11:30:00.000Z",
		lastError: "account_conflict",
	});
});

it("records the expired daily at Beijing midnight without disturbing the active weekly", async () => {
	const at = "2026-10-18T16:00:00.000Z";
	const s = await setup(at);
	await s.schedule("daily", "2026-10-18T15:59:00.000Z", ["23:59"]);
	const run = makeRun(
		"weekly",
		account,
		"nocoo",
		"weekly",
		"refresh",
		[],
		"2026-10-18T15:00:00.000Z",
	);
	await startRun(s.db(), run);
	await scheduleRefreshes(s.raw, at);
	expect((await getRun(s.db(), account, run.id))?.run.status).toBe("running");
	expect((await s.runs()).find((item) => item.error === "scheduled_slot_missed")).toMatchObject({
		status: "failed",
		schedule: { dueAt: "2026-10-18T15:59:00.000Z" },
		steps: [],
	});
});

it("records an explicit failed target after catalog preparation times out at thirty minutes", async () => {
	const at = "2026-10-16T11:30:00.000Z";
	const s = await setup(at);
	await s.db().prepare("DELETE FROM snapshots WHERE kind='factory'").run();
	await s.schedule("daily", at);
	await scheduleRefreshes(s.raw, at);
	const preparation = (await s.runs())[0];
	expect(preparation).toMatchObject({ mode: "catalog" });
	const lease = await claimRun(s.db(), String(preparation?.id), at);
	vi.setSystemTime("2026-10-16T12:00:00.000Z");
	await scheduleRefreshes(s.raw, new Date().toISOString());
	expect((await s.runs()).find((run) => run.requestKey === `daily:${at}`)).toMatchObject({
		status: "failed",
		error: "catalog_preparation_failed",
		schedule: { kind: "daily", dueAt: at },
	});
	if (!lease) throw new Error("fixture lease missing");
	expect(await saveRun(s.db(), lease, [], new Date().toISOString())).toBe(false);
});

it("keeps manual cooldowns when scheduled work is allowed to run", async () => {
	const s = await setup();
	const predecessor = makeRun("old", account, "nocoo", "old", "catalog", [], now);
	await startRun(s.db(), predecessor);
	await s
		.db()
		.prepare(
			"UPDATE factory_runs SET status='completed',payload=json_set(payload,'$.status','completed') WHERE id='old'",
		)
		.run();
	await expect(
		startRefresh(
			s.db(),
			{ id: account, login: "nocoo" },
			{
				account_id: account,
				requestKey: crypto.randomUUID(),
				mode: "catalog",
				depth: "quick",
				scope: "all",
			},
			now,
		),
	).rejects.toMatchObject({ code: "refresh_cooldown" });
	await s.schedule("daily", "2026-10-18T11:30:00.000Z");
	await scheduleRefreshes(s.raw, now);
	expect((await s.runs()).find((run) => run.status === "running")?.trigger).toBe("daily");
});

it.each(["browser", "machine"] as const)(
	"hands off pending daily immediately after %s cancellation without changing the response",
	async (surface) => {
		const s = await setup();
		await s.db().prepare("UPDATE accounts SET is_active=1 WHERE id=?").bind(account).run();
		await s.schedule("daily", "2026-10-18T11:30:00.000Z");
		const run = makeRun("cancelled", account, "nocoo", "manual", "refresh", [], now);
		await startRun(s.db(), run);
		await scheduleRefreshes(s.raw, now);
		expect((await readSchedules(s.db(), account))[0]?.lastError).toBe("account_conflict");
		const token = await createApiToken(s.db(), {
			accountId: account,
			label: "test",
			scopes: ["app:write"],
			creator: "test",
			expiresInDays: 1,
		});
		const send = vi.fn();
		const env = {
			DB: s.raw,
			FACTORY_QUEUE: { send },
			ENVIRONMENT: "development",
			GITHUB_API_BASE: "http://fixture",
		} as unknown as Env;
		const machine = surface === "machine";
		const response = await createApp().request(
			`http://localhost${machine ? `/api/v1/accounts/${account}/refresh-runs` : "/api/factory/runs"}/${run.id}/control`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "http://localhost",
					authorization: `Bearer ${token.token}`,
				},
				body: JSON.stringify(
					machine ? { action: "cancel" } : { account_id: account, action: "cancel" },
				),
			},
			env,
		);
		expect(response.status).toBe(machine ? 202 : 200);
		expect(await response.json()).toEqual({ account_id: account, id: run.id, status: "cancelled" });
		const next = (await s.runs()).find((item) => item.status === "running");
		expect(next).toMatchObject({ trigger: "daily", startedAt: now });
		expect(send).toHaveBeenCalledWith({ id: next?.id }, { delaySeconds: 0 });
	},
);

it("starts seven daily occurrences at the next healthy minute and keeps every request identity", async () => {
	const first = "2026-10-15T20:00:00.000Z";
	const s = await setup(first);
	await s.schedule("daily", first, ["04:00"]);
	for (let day = 0; day < 7; day++) {
		const due = new Date(Date.parse(first) + day * 86400_000).toISOString();
		const tick = new Date(Date.parse(due) + 60_000).toISOString();
		vi.setSystemTime(tick);
		await s.catalog(tick);
		await scheduleRefreshes(s.raw, tick);
		const run = (await s.runs()).find((item) => item.requestKey === `daily:${due}`);
		expect(run).toMatchObject({ status: "running", startedAt: tick, schedule: { dueAt: due } });
		const lease = await claimRun(s.db(), String(run?.id), tick);
		if (!lease) throw new Error("fixture lease missing");
		lease.run.status = "completed";
		lease.run.finishedAt = tick;
		expect(await saveRun(s.db(), lease, [], tick)).toBe(true);
	}
	expect(await s.runs()).toHaveLength(7);
});

it("rejects an expired daily during final SQL admission and audits it on recovery", async () => {
	const at = "2026-10-18T15:59:59.000Z";
	const s = await setup(at);
	const due = "2026-10-18T15:59:00.000Z";
	await s.schedule("daily", due, ["23:59"]);
	const clock = vi
		.fn()
		.mockReturnValueOnce(at)
		.mockReturnValueOnce(at)
		.mockReturnValue("2026-10-18T16:00:00.000Z");
	await expect(
		startRefresh(
			s.db(),
			{ id: account, login: "nocoo" },
			{
				account_id: account,
				requestKey: `daily:${due}`,
				mode: "refresh",
				depth: "quick",
				scope: "selected",
				repos: ["nocoo/app"],
			},
			at,
			"daily",
			{ kind: "daily", dueAt: due },
			clock,
		),
	).rejects.toMatchObject({ code: "schedule_deferred" });
	expect(await s.runs()).toEqual([]);
	await scheduleRefreshes(s.raw, "2026-10-18T16:00:00.000Z");
	expect(await s.runs()).toEqual([expect.objectContaining({ error: "scheduled_slot_missed" })]);
});

it("SQL rejects an older weekly contender when a different-slot current-day daily is pending", async () => {
	const s = await setup();
	await s.schedule("weekly", "2026-10-17T20:00:00.000Z", ["04:00"]);
	await s.schedule("daily", "2026-10-18T11:30:00.000Z");
	await expect(
		startRefresh(
			s.db(),
			{ id: account, login: "nocoo" },
			{
				account_id: account,
				requestKey: "weekly:2026-10-17T20:00:00.000Z",
				mode: "refresh",
				depth: "deep",
				scope: "all",
			},
			now,
			"weekly",
			{ kind: "weekly", dueAt: "2026-10-17T20:00:00.000Z" },
		),
	).rejects.toMatchObject({ code: "schedule_deferred" });
	expect(await s.runs()).toEqual([]);
});

it("checks the current pending daily at the next healthy tick without clearing earlier incidents", async () => {
	const before = "2026-10-18T11:29:00.000Z";
	const due = "2026-10-18T11:30:00.000Z";
	const s = await setup(before);
	await s.schedule("daily", due);
	const active = makeRun("weekly-active", account, "nocoo", "manual", "refresh", [], before);
	await startRun(s.db(), active);
	expect((await readSchedules(s.db(), account))[0]?.lastError).toBeNull();
	vi.setSystemTime("2026-10-18T11:31:00.000Z");
	await scheduleRefreshes(s.raw, new Date().toISOString());
	expect((await readSchedules(s.db(), account))[0]).toMatchObject({
		nextAt: due,
		lastError: "account_conflict",
	});
	for (const error of ["scheduled_slot_missed", "scheduled_slots_missed", "run_timed_out"]) {
		await s
			.db()
			.prepare("UPDATE refresh_schedules SET last_error=? WHERE account_id=?")
			.bind(error, account)
			.run();
		await scheduleRefreshes(s.raw, new Date().toISOString());
		expect((await readSchedules(s.db(), account))[0]?.lastError).toBe(error);
	}
	expect((await getRun(s.db(), account, active.id))?.run.status).toBe("running");
});

it("does not skip scheduled metadata at execution because of a preceding run's repository cooldown", async () => {
	const s = await setup();
	await s.schedule("daily", "2026-10-18T11:30:00.000Z");
	await s
		.db()
		.prepare("INSERT INTO factory_repo_state(account_id,repo,payload) VALUES(?,'nocoo/app',?)")
		.bind(
			account,
			JSON.stringify({
				repo: "nocoo/app",
				status: "success",
				nextAllowedAt: "2026-10-18T12:23:00.000Z",
			}),
		)
		.run();
	await scheduleRefreshes(s.raw, now);
	const run = (await s.runs()).find((item) => item.status === "running");
	if (!run) throw new Error("fixture run missing");
	run.cursor = run.steps.findIndex((step) => step.kind === "metadata");
	await s
		.db()
		.prepare("UPDATE factory_runs SET payload=? WHERE id=?")
		.bind(JSON.stringify(run), run.id)
		.run();
	await s
		.db()
		.prepare("UPDATE accounts SET token_ciphertext=? WHERE id=?")
		.bind(await encryptToken("fake", parseKeyBytes("0".repeat(64))), account)
		.run();
	const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
		Response.json({ data: { repository: rawRepo } }),
	);
	vi.stubGlobal("fetch", fetcher);
	await executeRunPage(
		{
			DB: s.raw,
			ENVIRONMENT: "development",
			GITHUB_API_BASE: "http://fixture",
			TOKEN_ENCRYPTION_KEY_V1: "0".repeat(64),
		} as unknown as Env,
		run.id,
		() => now,
	);
	expect((await getRun(s.db(), account, run.id))?.run.steps[run.cursor]).toMatchObject({
		status: "success",
		error: null,
	});
	expect(
		fetcher.mock.calls.filter(([, init]) => String(init.body).includes("openPrs:")),
	).toHaveLength(1);
});

it("retains committed successor work when immediate queue delivery fails and safely retries terminal messages", async () => {
	const s = await setup();
	await s.schedule("daily", "2026-10-18T11:30:00.000Z");
	const run = makeRun("terminal-retry", account, "nocoo", "manual", "catalog", [], now);
	run.steps = [];
	await startRun(s.db(), run);
	const send = vi
		.fn()
		.mockRejectedValueOnce(new Error("fixture queue down"))
		.mockResolvedValue(undefined);
	const ack = vi.fn(),
		retry = vi.fn();
	const message = { body: { id: run.id }, ack, retry };
	const env = { DB: s.raw, FACTORY_QUEUE: { send } } as unknown as Env;
	await consumeFactory({ messages: [message] } as unknown as MessageBatch<unknown>, env);
	expect(retry).toHaveBeenCalledWith({ delaySeconds: 5 });
	await consumeFactory({ messages: [message] } as unknown as MessageBatch<unknown>, env);
	expect(ack).toHaveBeenCalledTimes(1);
	expect((await s.runs()).filter((item) => item.trigger === "daily")).toHaveLength(1);
	expect((await getRun(s.db(), account, run.id))?.run.status).toBe("completed");
});

it("does not start a stale occurrence disabled between planning and the final INSERT", async () => {
	const s = await setup();
	await s.schedule("daily", "2026-10-18T11:30:00.000Z");
	const batch = s.raw.batch.bind(s.raw);
	vi.spyOn(s.raw, "batch").mockImplementationOnce(async (writes) => {
		await s
			.db()
			.prepare("UPDATE refresh_schedules SET enabled=0 WHERE account_id=? AND kind='daily'")
			.bind(account)
			.run();
		return batch(writes);
	});
	await scheduleRefreshes(s.raw, now);
	expect(await s.runs()).toEqual([]);
	expect((await readSchedules(s.db(), account))[0]).toMatchObject({
		enabled: false,
		lastRunId: null,
	});
});

it("keeps a daily accepted before midnight alive across the day boundary without a missed duplicate", async () => {
	const at = "2026-10-18T15:59:59.000Z";
	const s = await setup(at);
	await s.schedule("daily", "2026-10-18T15:59:00.000Z", ["23:59"]);
	await scheduleRefreshes(s.raw, at);
	await scheduleRefreshes(s.raw, "2026-10-18T16:00:00.000Z");
	expect(await s.runs()).toEqual([expect.objectContaining({ status: "running", startedAt: at })]);
});

it("keeps account-scoped control handoff from expiring another account's runs", async () => {
	const s = await setup();
	const other = "b".repeat(21);
	const started = "2026-10-18T11:00:00.000Z";
	await s
		.db()
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'other','fake','fake',?,?)",
		)
		.bind(other, started, started)
		.run();
	const run = makeRun("other-expired", other, "other", "manual", "catalog", [], started);
	await startRun(s.db(), run);
	await handoffAccount({ DB: s.raw, FACTORY_QUEUE: { send: vi.fn() } } as unknown as Env, account);
	expect((await getRun(s.db(), other, run.id))?.run.status).toBe("running");
});
