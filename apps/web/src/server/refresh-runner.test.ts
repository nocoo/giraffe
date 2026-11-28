import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { annualContributionCalendar } from "../../../../tests/fixtures/contribution-calendar";
import { sqliteFixture } from "../../../../tests/fixtures/sqlite";
import type { Env } from "./env";
import { createDb } from "./lib/db/d1";
import { ApiError } from "./lib/errors";
import { transport } from "./lib/refresh-collection/transport";
import * as refreshStore from "./lib/refresh-store";
import { getRefreshRun, saveRefreshRun } from "./lib/refresh-store";
import { encryptToken, parseKeyBytes } from "./lib/token-crypto";
import { cancelRefresh, RefreshRunner, scheduleRefresh, startRefresh } from "./refresh-runner";

const collectors = vi.hoisted(() => ({ collectAccount: vi.fn(), collectRepository: vi.fn() }));
vi.mock("./lib/refresh-collection", () => collectors);
const collected = (requests: number, graphql: number, rest: number, reasons: string[] = []) => ({
	requests,
	requestBreakdown: { graphql, rest },
	partial: reasons.length > 0,
	reasons,
});
const rateLimitError = (msFromNow = 120_000, status?: number) =>
	new ApiError(
		503,
		"github_rate_limited",
		"safe",
		new Date(Date.now() + msFromNow).toISOString(),
		status,
	);
function resetCollectors() {
	collectors.collectAccount.mockReset().mockResolvedValue({
		repos: ["octo/one", "octo/two"],
		...collected(1, 1, 0),
	});
	collectors.collectRepository.mockReset().mockResolvedValue(collected(3, 1, 2));
}
beforeEach(resetCollectors);
afterEach(() => vi.useRealTimers());

async function setup() {
	const raw = sqliteFixture();
	const token = `ghp_${"T".repeat(36)}`;
	const ciphertext = await encryptToken(token, parseKeyBytes("0".repeat(64)));
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,key_version,created_at,updated_at) VALUES('account','octo',?,'TTTT',1,'t','t')",
		)
		.bind(ciphertext)
		.run();
	const values = new Map<string, unknown>();
	let alarm: number | null = null;
	const storage = {
		get: vi.fn(async (key: string) => values.get(key)),
		put: vi.fn(async (key: string, value: unknown) => {
			values.set(key, value);
		}),
		delete: vi.fn(async (key: string) => values.delete(key)),
		getAlarm: vi.fn(async () => alarm),
		setAlarm: vi.fn(async (at: number) => {
			alarm = at;
		}),
		deleteAlarm: vi.fn(async () => {
			alarm = null;
		}),
	};
	let lock: Promise<unknown> = Promise.resolve();
	let locked = false;
	const state = {
		storage,
		blockConcurrencyWhile: <Value>(fn: () => Promise<Value>) => {
			const next = lock.then(async () => {
				locked = true;
				try {
					return await fn();
				} finally {
					locked = false;
				}
			});
			lock = next.catch(() => {});
			return next;
		},
	} as unknown as DurableObjectState;
	const env = {
		DB: raw,
		TOKEN_ENCRYPTION_KEY_V1: "0".repeat(64),
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
	} as unknown as Env;
	let runner = new RefreshRunner(state, env);
	env.REFRESH_RUNNER = {
		getByName: vi.fn(() => ({ fetch: (request: Request) => runner.fetch(request) })),
	} as unknown as DurableObjectNamespace;
	const db = () => createDb(raw);
	const cancelRequest = (id: string, accountId = "account") =>
		runner.fetch(
			new Request("https://refresh.internal/cancel", {
				method: "POST",
				body: JSON.stringify({ accountId, id }),
			}),
		);
	return {
		raw,
		env,
		token,
		storage,
		runner,
		db,
		cancelRequest,
		alarmAt: () => alarm,
		isLocked: () => locked,
		restart() {
			runner = new RefreshRunner(state, env);
			return runner;
		},
	};
}
type Fixture = Awaited<ReturnType<typeof setup>>;

async function insertAccount(fixture: Fixture, id: string) {
	await fixture.raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?,'fake','fake','t','t')",
		)
		.bind(id, id)
		.run();
}
async function cancelInD1(fixture: Fixture, runId: string, at = new Date().toISOString()) {
	await refreshStore.requestRefreshCancel(fixture.db(), "account", runId, at);
}
async function deliverNextAlarm(fixture: Fixture) {
	const retry = (await fixture.storage.get("retry")) as
		| { notBefore: number; exhausted?: unknown }
		| undefined;
	const active = await refreshStore.activeRefreshRun(fixture.db(), "account");
	const retryAt = active?.cancelRequested || retry?.exhausted ? 0 : (retry?.notBefore ?? 0);
	vi.useFakeTimers({
		now: Math.max(Date.now(), fixture.alarmAt() ?? 0, retryAt),
		toFake: ["Date"],
	});
	await fixture.storage.deleteAlarm();
	await fixture.restart().alarm();
}
async function deferredCollection() {
	let release: ((value: unknown) => void) | undefined;
	collectors.collectRepository.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = resolve as (value: unknown) => void;
			}),
	);
	return async () => {
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		return { release: (value: unknown) => release?.(value) };
	};
}
async function withSaveSpy(
	impl: (
		orig: typeof refreshStore.saveRefreshRun,
		...args: Parameters<typeof refreshStore.saveRefreshRun>
	) => ReturnType<typeof refreshStore.saveRefreshRun>,
	fn: (spy: {
		mock: { calls: Array<[unknown, Parameters<typeof refreshStore.saveRefreshRun>[1]]> };
	}) => Promise<void>,
) {
	const orig = refreshStore.saveRefreshRun;
	const spy = vi
		.spyOn(refreshStore, "saveRefreshRun")
		.mockImplementation((...args) => impl(orig, ...args));
	try {
		await fn(
			spy as unknown as {
				mock: { calls: Array<[unknown, Parameters<typeof refreshStore.saveRefreshRun>[1]]> };
			},
		);
	} finally {
		spy.mockRestore();
	}
}

it("keeps a 90-day backfill account-locked across restarts without changing daily parameters", async () => {
	const fixture = await setup();
	const at = new Date("2026-10-28T19:00:00.000Z");
	const params = { lookbackDays: 90, dimensions: ["commits", "alerts"] };
	const [first, repeated] = await Promise.all([
		startRefresh(fixture.env, "account", params, "manual", at),
		startRefresh(fixture.env, "account", params, "manual", at),
	]);
	expect(repeated.id).toBe(first.id);
	expect(first.params).toMatchObject({
		lookbackDays: 90,
		since: "2026-07-31",
		until: "2026-10-28",
	});
	fixture.restart();
	for (const other of [{ lookbackDays: 89 }, { ...params, force: true }, {}]) {
		await expect(startRefresh(fixture.env, "account", other, "manual", at)).rejects.toMatchObject({
			status: 409,
			code: "refresh_conflict",
		});
	}
	vi.useFakeTimers({ now: new Date("2026-10-29T19:00:00.000Z"), toFake: ["Date"] });
	await fixture.restart().alarm();
	expect(collectors.collectRepository.mock.calls[0]?.[0].days).toHaveLength(90);
	expect(collectors.collectRepository.mock.calls[0]?.[0].days[0].date).toBe("2026-07-31");
	expect(collectors.collectRepository.mock.calls[0]?.[0].days.at(-1).date).toBe("2026-10-28");
	expect(await getRefreshRun(fixture.db(), "account", first.id)).toMatchObject({
		status: "completed",
		params: { lookbackDays: 90 },
	});
	const daily = await startRefresh(fixture.env, "account", {}, "scheduled", at);
	expect(daily.params).toMatchObject({ since: "2026-10-28", until: "2026-10-28" });
	expect(daily.params).not.toHaveProperty("lookbackDays");
});

it("persists metric guard warnings and actions observation audits from collection", async () => {
	const fixture = await setup();
	collectors.collectAccount.mockResolvedValue({ repos: ["octo/one"], ...collected(1, 1, 0) });
	collectors.collectRepository.mockImplementationOnce(
		async (context: { onMetricGuard?: (event: unknown) => void }) => {
			context.onMetricGuard?.({
				code: "zero_guard_kept",
				repo: "octo/one",
				day: "2026-10-28",
				field: "commits",
			});
			return {
				...collected(2, 1, 1),
				actionsObservationAudit: {
					repo: "octo/one",
					outsideWindowDays: 3,
					missingObservationDays: 1,
					missingBranchDays: 0,
				},
			};
		},
	);
	const run = await startRefresh(fixture.env, "account", { repo: "octo/one" });
	await fixture.runner.alarm();
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		metricGuardEvents: [
			{ code: "zero_guard_kept", repo: "octo/one", day: "2026-10-28", field: "commits" },
		],
		actionsObservationAudit: [
			{
				repo: "octo/one",
				outsideWindowDays: 3,
				missingObservationDays: 1,
				missingBranchDays: 0,
			},
		],
	});
});

it("settles D1-only cancellation after CPU reset, stall, or same-wake transition", async () => {
	const f1 = await setup();
	const r1 = await startRefresh(f1.env, "account", { repo: "octo/one" });
	await saveRefreshRun(f1.db(), {
		...r1,
		status: "running",
		phase: "repos",
		repos: ["octo/one"],
		aReused: true,
	});
	await cancelInD1(f1, r1.id);
	expect(await f1.storage.get(`cancel:${r1.id}`)).toBeUndefined();
	await f1.restart().alarm();
	expect(await getRefreshRun(f1.db(), "account", r1.id)).toMatchObject({
		status: "cancelled",
		cancelRequested: true,
		completedRepos: 0,
		requests: 0,
	});
	expect(collectors.collectAccount).not.toHaveBeenCalled();
	expect(collectors.collectRepository).not.toHaveBeenCalled();
	expect(f1.alarmAt()).toBeNull();

	const f2 = await setup();
	collectors.collectAccount.mockClear();
	const r2 = await startRefresh(f2.env, "account", {});
	const pending = await deferredCollection();
	const alarm = f2.runner.alarm();
	const { release } = await pending();
	await cancelInD1(f2, r2.id);
	release(collected(3, 1, 2));
	await alarm;
	expect(await getRefreshRun(f2.db(), "account", r2.id)).toMatchObject({
		status: "cancelled",
		completedRepos: 1,
		requests: 4,
		cancelRequested: true,
	});

	const f3 = await setup();
	resetCollectors();
	const r3 = await startRefresh(f3.env, "account", {});
	await withSaveSpy(
		async (orig, db, next) => {
			const saved = await orig(db, next);
			if (next.phase === "repos" && !next.cancelRequested) {
				await cancelInD1(f3, r3.id, next.updatedAt);
			}
			return saved;
		},
		async () => {
			await f3.runner.alarm();
			expect(await getRefreshRun(f3.db(), "account", r3.id)).toMatchObject({
				status: "cancelled",
				cancelRequested: true,
				completedRepos: 0,
			});
		},
	);
});

it.each(["account", "repos"] as const)(
	"bounds uncommitted %s attempts after three runtime resets",
	async (phase) => {
		const fixture = await setup();
		const run = await startRefresh(fixture.env, "account", {});
		if (phase === "repos") {
			await saveRefreshRun(fixture.db(), { ...run, status: "running", phase, repos: ["octo/one"] });
		}
		const prototype = Object.getPrototypeOf(fixture.runner) as { settle: () => Promise<unknown> };
		const reset = vi
			.spyOn(prototype, "settle")
			.mockRejectedValue(new Error("runtime reset before settlement"));
		try {
			for (let attempt = 0; attempt < 3; attempt++) {
				await expect(deliverNextAlarm(fixture)).rejects.toThrow("runtime reset before settlement");
			}
		} finally {
			reset.mockRestore();
		}
		await deliverNextAlarm(fixture);
		expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
			status: phase === "account" ? "failed" : "partial",
			phase: "done",
			errorCode: "refresh_interrupted",
			requests: 0,
			partialReasons: [expect.objectContaining({ codes: ["refresh_interrupted"] })],
		});
		expect(
			phase === "account" ? collectors.collectAccount : collectors.collectRepository,
		).toHaveBeenCalledTimes(3);
		expect(fixture.alarmAt()).toBeNull();
	},
);

it("replays interrupted-attempt exhaustion and prioritizes persisted cancellation", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	await fixture.storage.put("executing", { key: `${run.id}:account:0:0`, interruptions: 2 });
	let failures = 2;
	await withSaveSpy(
		(orig, db, next) =>
			next.errorCode === "refresh_interrupted" && failures-- > 0
				? Promise.reject(new Error("save interrupted"))
				: orig(db, next),
		async (spy) => {
			for (let attempt = 0; attempt < 2; attempt++) {
				await expect(deliverNextAlarm(fixture)).rejects.toThrow("save interrupted");
				expect(fixture.alarmAt()).toBe(Date.now() + 5_000);
			}
			await deliverNextAlarm(fixture);
			expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
				status: "failed",
				errorCode: "refresh_interrupted",
			});
			expect(collectors.collectAccount).not.toHaveBeenCalled();
			expect(await fixture.storage.get("executing")).toBeUndefined();
			expect(
				new Set(spy.mock.calls.map((call) => (call[1] as { finishedAt: unknown }).finishedAt)).size,
			).toBe(1);
		},
	);

	const f2 = await setup();
	collectors.collectAccount.mockClear();
	const r2 = await startRefresh(f2.env, "account", {});
	await saveRefreshRun(f2.db(), { ...r2, status: "running" });
	await f2.storage.put("executing", { key: `${r2.id}:account:0:0`, interruptions: 2 });
	await cancelInD1(f2, r2.id);
	await deliverNextAlarm(f2);
	expect(await getRefreshRun(f2.db(), "account", r2.id)).toMatchObject({
		status: "cancelled",
		errorCode: null,
	});
	expect(await f2.storage.get("executing")).toBeUndefined();
});

it("handles concurrent D1 cancel during rate-limit, heartbeat checks, run deletion and marker cleanup", async () => {
	vi.useFakeTimers({ now: new Date("2026-10-29T04:00:00.000Z"), toFake: ["Date"] });
	const f1 = await setup();
	const r1 = await startRefresh(f1.env, "account", {});
	collectors.collectRepository.mockRejectedValue(rateLimitError(3_600_000, 429));
	const put = f1.storage.put.getMockImplementation();
	f1.storage.put.mockImplementation(async (key, value) => {
		if (key === "retry") await cancelInD1(f1, r1.id);
		await put?.(key, value);
	});
	await f1.runner.alarm();
	expect(f1.alarmAt()).toBeLessThanOrEqual(Date.now() + 5_000);
	await deliverNextAlarm(f1);
	expect(await getRefreshRun(f1.db(), "account", r1.id)).toMatchObject({
		status: "cancelled",
		cancelRequested: true,
	});
	expect(collectors.collectRepository).toHaveBeenCalledOnce();

	const f2 = await setup();
	collectors.collectAccount.mockClear();
	const r2 = await startRefresh(f2.env, "account", {});
	collectors.collectAccount.mockRejectedValue(rateLimitError(3_600_000, 429));
	await f2.runner.alarm();
	for (let heartbeat = 0; heartbeat < 3; heartbeat++) {
		vi.setSystemTime(f2.alarmAt() as number);
		await f2.storage.deleteAlarm();
		await f2.restart().alarm();
		expect(collectors.collectAccount).toHaveBeenCalledOnce();
		expect(await f2.storage.get("executing")).toBeUndefined();
		expect(f2.alarmAt()).toBe(Date.now() + 5_000);
	}
	await cancelInD1(f2, r2.id);
	vi.setSystemTime(f2.alarmAt() as number);
	await f2.storage.deleteAlarm();
	await f2.restart().alarm();
	expect(await getRefreshRun(f2.db(), "account", r2.id)).toMatchObject({ status: "cancelled" });
	vi.useRealTimers();

	const f3 = await setup();
	resetCollectors();
	const r3 = await startRefresh(f3.env, "account", {});
	collectors.collectAccount.mockImplementationOnce(async () => {
		await f3.raw.prepare("DELETE FROM refresh_runs WHERE id=?").bind(r3.id).run();
		return { repos: ["octo/one"], ...collected(1, 1, 0) };
	});
	await f3.runner.alarm();
	expect(collectors.collectRepository).not.toHaveBeenCalled();
	expect(f3.alarmAt()).toBeNull();

	const f4 = await setup();
	collectors.collectAccount.mockClear();
	const r4 = await startRefresh(f4.env, "account", {});
	collectors.collectAccount.mockRejectedValue(
		new ApiError(503, "github_unavailable", "unavailable"),
	);
	const remove = f4.storage.delete.getMockImplementation();
	let failures = 3;
	f4.storage.delete.mockImplementation(async (key) => {
		if (key === "executing" && failures-- > 0) throw new Error("cleanup interrupted");
		return remove?.(key) ?? false;
	});
	for (let attempt = 0; attempt < 3; attempt++) {
		await expect(deliverNextAlarm(f4)).rejects.toThrow("cleanup interrupted");
		const retry = (await f4.storage.get("retry")) as { notBefore: number };
		vi.setSystemTime(retry.notBefore);
	}
	await deliverNextAlarm(f4);
	expect(await getRefreshRun(f4.db(), "account", r4.id)).toMatchObject({
		status: "failed",
		errorCode: "github_unavailable",
	});
	expect(collectors.collectAccount).toHaveBeenCalledTimes(4);
});

it("durably queues one account run, executes A then B serial, and fails closed on account error", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	expect(run.status).toBe("queued");
	expect((await startRefresh(fixture.env, "account", {})).id).toBe(run.id);
	await fixture.restart().alarm();
	expect(collectors.collectAccount.mock.invocationCallOrder[0]).toBeLessThan(
		collectors.collectRepository.mock.invocationCallOrder[0] ?? 0,
	);
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "completed",
		phase: "done",
		completedRepos: 2,
		requests: 7,
		requestBreakdown: {
			total: 7,
			graphql: 3,
			rest: 4,
			a: { graphql: 1, rest: 0 },
			b: { graphql: 2, rest: 4 },
		},
		partialReasons: [],
		cancelRequested: false,
	});
	expect(
		JSON.stringify((await fixture.raw.prepare("SELECT payload FROM refresh_runs").all()).results),
	).not.toContain(fixture.token);
	expect(fixture.alarmAt()).toBeNull();

	const f2 = await setup();
	collectors.collectRepository.mockClear();
	const failed = await startRefresh(f2.env, "account", {});
	collectors.collectAccount.mockRejectedValue(new ApiError(401, "github_unauthorized", f2.token));
	await f2.runner.alarm();
	expect(collectors.collectRepository).not.toHaveBeenCalled();
	expect(await getRefreshRun(f2.db(), "account", failed.id)).toMatchObject({
		status: "failed",
		errorCode: "github_unauthorized",
	});
});

it("retries transient repository failures with bounded attempts then continues", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	collectors.collectRepository.mockRejectedValue(rateLimitError());
	for (let attempt = 0; attempt < 4; attempt++) await deliverNextAlarm(fixture);
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		completedRepos: 1,
		partial: true,
		partialReasons: [{ repo: "octo/one", codes: ["github_rate_limited"] }],
	});
	collectors.collectRepository.mockResolvedValue(collected(2, 0, 2));
	await deliverNextAlarm(fixture);
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "partial",
		completedRepos: 2,
	});
});

it("deduplicates scheduled runs, queues behind adhoc, and rejects invalid inputs/bindings", async () => {
	const fixture = await setup();
	await fixture.runner.alarm();
	collectors.collectAccount.mockResolvedValue({ repos: [], ...collected(1, 1, 0) });
	const at = new Date("2026-10-28T19:00:00.000Z");
	const run = await startRefresh(fixture.env, "account", {}, "scheduled", at);
	await fixture.runner.alarm();
	expect((await startRefresh(fixture.env, "account", {}, "scheduled", at)).id).toBe(run.id);

	const adhoc = await startRefresh(fixture.env, "account", { repo: "octo/one" });
	await expect(startRefresh(fixture.env, "account", { repo: "octo/two" })).rejects.toMatchObject({
		code: "refresh_conflict",
	});
	const scheduled = await startRefresh(fixture.env, "account", {}, "scheduled");
	expect(scheduled.id).not.toBe(adhoc.id);
	await fixture.runner.alarm();
	expect(fixture.alarmAt()).not.toBeNull();
	await fixture.runner.alarm();
	expect(await getRefreshRun(fixture.db(), "account", scheduled.id)).toMatchObject({
		status: "completed",
	});

	await expect(startRefresh(fixture.env, "missing", {})).rejects.toMatchObject({
		code: "account_missing",
	});
	expect((await fixture.runner.fetch(new Request("https://refresh.internal"))).status).toBe(405);
	const { REFRESH_RUNNER: _binding, ...withoutBinding } = fixture.env;
	await expect(startRefresh(withoutBinding, "account", {})).rejects.toMatchObject({
		code: "refresh_unavailable",
	});
	for (const body of [
		"{",
		"{}",
		JSON.stringify({
			accountId: "account",
			params: {},
			trigger: "bad",
			at: new Date().toISOString(),
		}),
	]) {
		expect(
			(
				await fixture.runner.fetch(
					new Request("https://refresh.internal/start", { method: "POST", body }),
				)
			).status,
		).toBeGreaterThanOrEqual(400);
	}
	expect(
		(
			await fixture.runner.fetch(
				new Request("https://refresh.internal/other", { method: "POST", body: "{}" }),
			)
		).status,
	).toBe(404);
	await startRefresh(fixture.env, "account", {});
	await insertAccount(fixture, "other");
	await expect(startRefresh(fixture.env, "other", {})).rejects.toMatchObject({
		code: "validation_failed",
	});
});

it("schedules via cron, handles invalid credentials/cursor, and continues other accounts on failure", async () => {
	const fixture = await setup();
	await scheduleRefresh(fixture.env, Date.parse("2026-10-28T19:00:00.000Z"));
	expect(collectors.collectAccount).not.toHaveBeenCalled();
	expect(
		(await fixture.raw.prepare("SELECT schedule_day,status FROM refresh_runs").all()).results,
	).toEqual([{ schedule_day: "2026-10-29", status: "queued" }]);

	await insertAccount(fixture, "second");
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(Response.json({ error: { code: fixture.token } }, { status: 503 }))
		.mockResolvedValueOnce(Response.json({ id: "second-run" }, { status: 202 }));
	const getByName = vi.fn(() => ({ fetch }));
	const originalRunner = fixture.env.REFRESH_RUNNER;
	fixture.env.REFRESH_RUNNER = { getByName } as unknown as DurableObjectNamespace;
	await expect(scheduleRefresh(fixture.env, Date.now())).rejects.toMatchObject({
		code: "refresh_schedule_failed",
		message: "1 account schedules failed",
	});
	expect(getByName.mock.calls).toEqual([["account"], ["second"]]);

	if (originalRunner) fixture.env.REFRESH_RUNNER = originalRunner;
	await fixture.raw.prepare("DELETE FROM refresh_runs").run();
	const run = await startRefresh(fixture.env, "account", {});
	Object.assign(fixture.env, { TOKEN_ENCRYPTION_KEY_V1: "" });
	await fixture.runner.alarm();
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "failed",
		errorCode: "encryption_misconfigured",
	});
	Object.assign(fixture.env, { TOKEN_ENCRYPTION_KEY_V1: "0".repeat(64) });
	const next = await startRefresh(fixture.env, "account", {});
	await saveRefreshRun(fixture.db(), { ...next, phase: "repos" });
	await fixture.runner.alarm();
	expect(await getRefreshRun(fixture.db(), "account", next.id)).toMatchObject({
		status: "failed",
		errorCode: "validation_failed",
	});
	await fixture.raw.prepare("DELETE FROM accounts").run();
	await scheduleRefresh(fixture.env, Date.now());
});

it("bounds unknown repository failures, preserves retry deadlines, and counts failed request attempts", async () => {
	const fixture = await setup();
	collectors.collectAccount.mockResolvedValue({
		repos: ["octo/one"],
		...collected(1, 1, 0, ["contributions:unavailable"]),
	});
	const run = await startRefresh(fixture.env, "account", {});
	collectors.collectRepository.mockRejectedValueOnce(
		new ApiError(502, "github_error", "safe", "invalid"),
	);
	await fixture.runner.alarm();
	collectors.collectRepository.mockRejectedValue(new Error(fixture.token));
	for (let attempt = 0; attempt < 3; attempt++) await deliverNextAlarm(fixture);
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "partial",
		errorCode: "refresh_failed",
		completedRepos: 1,
		partialReasons: [
			{ repo: null, codes: ["contributions:unavailable"] },
			{ repo: "octo/one", codes: ["refresh_failed"] },
		],
	});
	expect(
		JSON.stringify((await fixture.raw.prepare("SELECT payload FROM refresh_runs").all()).results),
	).not.toContain(fixture.token);

	const f2 = await setup();
	collectors.collectAccount.mockClear();
	const r2 = await startRefresh(f2.env, "account", {});
	collectors.collectAccount
		.mockImplementationOnce(async (context) => {
			context.onRequests(2, { graphql: 2, rest: 0 });
			throw new ApiError(502, "github_error", "safe");
		})
		.mockResolvedValueOnce({ repos: [], ...collected(1, 0, 1) });
	await f2.runner.alarm();
	expect(await getRefreshRun(f2.db(), "account", r2.id)).toMatchObject({
		requests: 2,
		requestBreakdown: { total: 2, graphql: 2, rest: 0, a: { graphql: 2, rest: 0 } },
	});
	await deliverNextAlarm(f2);
	expect(await getRefreshRun(f2.db(), "account", r2.id)).toMatchObject({
		requests: 3,
		requestBreakdown: { total: 3, graphql: 2, rest: 1, a: { graphql: 2, rest: 1 } },
		status: "completed",
	});

	const f3 = await setup();
	resetCollectors();
	const r3 = await startRefresh(f3.env, "account", {});
	collectors.collectAccount.mockRejectedValueOnce(rateLimitError());
	await f3.runner.alarm();
	const alarms = f3.storage.setAlarm.mock.calls.length;
	expect((await startRefresh(f3.env, "account", {})).id).toBe(r3.id);
	await expect(startRefresh(f3.env, "account", { force: true })).rejects.toMatchObject({
		code: "refresh_conflict",
	});
	await startRefresh(f3.env, "account", {}, "scheduled");
	expect(f3.storage.setAlarm).toHaveBeenCalledTimes(alarms);
	collectors.collectAccount.mockResolvedValue({ repos: [], ...collected(1, 1, 0) });
	await deliverNextAlarm(f3);
	expect(await getRefreshRun(f3.db(), "account", r3.id)).toMatchObject({
		status: "completed",
		errorCode: null,
	});
});

it("does not retry an adhoc missing repo and serializes idle cleanup with incoming starts", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", { repo: "octo/missing" });
	collectors.collectAccount.mockImplementationOnce(async (context) => {
		context.onRequests(1, { graphql: 1, rest: 0 });
		throw new ApiError(404, "not_found", "repository missing");
	});
	await fixture.runner.alarm();
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "failed",
		errorCode: "not_found",
		requests: 1,
	});
	expect(fixture.storage.put).not.toHaveBeenCalledWith("retry", expect.anything());

	collectors.collectAccount.mockResolvedValue({ repos: [], ...collected(1, 1, 0) });
	await startRefresh(fixture.env, "account", {});
	let incoming: ReturnType<typeof startRefresh> | undefined;
	let released = false;
	fixture.storage.deleteAlarm.mockImplementationOnce(async () => {
		expect(fixture.isLocked()).toBe(true);
		incoming = startRefresh(fixture.env, "account", { force: true });
		await new Promise<void>((resolve) => setImmediate(resolve));
		released = true;
	});
	await fixture.runner.alarm();
	const queued = await incoming;
	expect(queued?.status).toBe("queued");
	expect(released).toBe(true);
	await fixture.runner.alarm();
	expect(await getRefreshRun(fixture.db(), "account", queued?.id ?? "")).toMatchObject({
		status: "completed",
	});
});

it("cancels a running run, queued run, idempotently, and never resurrects on concurrent alarm", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	const inFlight = await deferredCollection();
	const step = fixture.runner.alarm();
	const { release } = await inFlight();
	const accepted = await fixture.cancelRequest(run.id);
	expect(accepted.status).toBe(202);
	expect(await accepted.json()).toMatchObject({
		id: run.id,
		status: "running",
		cancelRequested: true,
		completedRepos: 0,
	});
	release(collected(3, 1, 2));
	await step;
	const first = await fixture.cancelRequest(run.id);
	expect(first.status).toBe(200);
	const terminal = await first.json();
	expect(terminal).toMatchObject({ status: "cancelled", completedRepos: 1, requests: 4 });
	expect(await (await fixture.cancelRequest(run.id)).json()).toEqual(terminal);
	await fixture.runner.alarm();
	expect(collectors.collectRepository).toHaveBeenCalledOnce();
	expect((await fixture.cancelRequest("missing")).status).toBe(404);
	await insertAccount(fixture, "other");
	expect((await fixture.cancelRequest(run.id, "other")).status).toBe(400);
	expect((await fixture.cancelRequest("missing", "missing")).status).toBe(404);

	const completed = await startRefresh(fixture.env, "account", {});
	await fixture.runner.alarm();
	expect(await (await fixture.cancelRequest(completed.id)).json()).toMatchObject({
		status: "completed",
	});

	const background: Promise<unknown>[] = [];
	const waitUntil = (work: Promise<unknown>) => {
		background.push(work);
	};
	const helperRun = await startRefresh(fixture.env, "account", {});
	expect((await cancelRefresh(fixture.env, "account", helperRun.id, waitUntil)).status).toBe(
		"cancelled",
	);
	await expect(
		cancelRefresh(fixture.env, "missing", helperRun.id, waitUntil),
	).rejects.toMatchObject({
		code: "not_found",
	});
	const { REFRESH_RUNNER: _binding, ...withoutBinding } = fixture.env;
	await expect(
		cancelRefresh(withoutBinding, "account", helperRun.id, waitUntil),
	).resolves.toMatchObject({
		status: "cancelled",
	});
	await Promise.all(background);
});

it.each(["account", "repos"] as const)(
	"preserves accepted cancellation when the current %s step fails fatally",
	async (phase) => {
		const fixture = await setup();
		const run = await startRefresh(fixture.env, "account", {});
		if (phase === "repos") {
			await saveRefreshRun(fixture.db(), { ...run, phase: "repos", repos: ["octo/one"] });
		}
		let rejectCollection: ((error: Error) => void) | undefined;
		const collector =
			phase === "account" ? collectors.collectAccount : collectors.collectRepository;
		collector.mockImplementationOnce(async (context) => {
			context.onRequests(1, { graphql: 1, rest: 0 });
			return new Promise((_resolve, reject) => {
				rejectCollection = reject;
			});
		});
		const step = fixture.runner.alarm();
		await vi.waitFor(() => expect(rejectCollection).toBeTypeOf("function"));
		expect((await fixture.cancelRequest(run.id)).status).toBe(202);
		rejectCollection?.(new ApiError(401, "github_unauthorized", "safe", null, 401));
		await step;
		const cancelled = await getRefreshRun(fixture.db(), "account", run.id);
		expect(cancelled).toMatchObject({
			status: "cancelled",
			phase: "done",
			cancelRequested: true,
			errorCode: "github_unauthorized",
			partialReasons: [
				{
					repo: phase === "repos" ? "octo/one" : null,
					codes: ["github_unauthorized"],
					failures: [{ dimension: null, code: "github_unauthorized", httpStatus: 401 }],
				},
			],
		});
	},
);

it("cancels queued/in-flight runs safely and wakes queued schedules without resurrection", async () => {
	const f1 = await setup();
	collectors.collectAccount.mockResolvedValue({ repos: [], ...collected(1, 1, 0) });
	const adhoc = await startRefresh(f1.env, "account", { repo: "octo/one" });
	const scheduled = await startRefresh(f1.env, "account", {}, "scheduled");
	expect((await f1.cancelRequest(adhoc.id)).status).toBe(200);
	expect(collectors.collectAccount).not.toHaveBeenCalled();
	await f1.runner.alarm();
	expect(await getRefreshRun(f1.db(), "account", scheduled.id)).toMatchObject({
		status: "completed",
	});
	expect((await getRefreshRun(f1.db(), "account", adhoc.id))?.status).toBe("cancelled");

	const f2 = await setup();
	resetCollectors();
	const run = await startRefresh(f2.env, "account", {});
	collectors.collectRepository.mockRejectedValue(rateLimitError());
	await f2.runner.alarm();
	expect((await f2.cancelRequest(run.id)).status).toBe(202);
	expect(f2.alarmAt()).toBeLessThanOrEqual(Date.now() + 1_000);
	await f2.runner.alarm();
	expect(collectors.collectRepository).toHaveBeenCalledOnce();
	expect(await getRefreshRun(f2.db(), "account", run.id)).toMatchObject({ status: "cancelled" });
	expect(f2.storage.delete).toHaveBeenCalledWith("retry");

	const f3 = await setup();
	collectors.collectAccount.mockResolvedValue({ repos: ["octo/one"], ...collected(1, 1, 0) });
	const r3 = await startRefresh(f3.env, "account", {});
	const inFlight = await deferredCollection();
	const step = f3.runner.alarm();
	const { release } = await inFlight();
	expect((await f3.cancelRequest(r3.id)).status).toBe(202);
	await f3.runner.alarm();
	expect(await getRefreshRun(f3.db(), "account", r3.id)).toMatchObject({ status: "cancelled" });
	release(collected(3, 1, 2));
	await step;
	expect(await getRefreshRun(f3.db(), "account", r3.id)).toMatchObject({
		status: "cancelled",
		completedRepos: 1,
		requests: 4,
	});

	const f4 = await setup();
	const running = await startRefresh(f4.env, "account", {});
	const p4 = await deferredCollection();
	const s4 = f4.runner.alarm();
	const { release: rel4 } = await p4();
	const queued = await startRefresh(f4.env, "account", {}, "scheduled");
	const safetyAlarm = f4.alarmAt();
	expect((await f4.cancelRequest(queued.id)).status).toBe(200);
	expect(f4.alarmAt()).toBe(safetyAlarm);
	rel4(collected(3, 1, 2));
	await s4;
	expect(await getRefreshRun(f4.db(), "account", queued.id)).toMatchObject({ status: "cancelled" });
	await f4.runner.alarm();
	expect(await getRefreshRun(f4.db(), "account", running.id)).toMatchObject({
		status: "completed",
		partialReasons: [],
	});

	const f5 = await setup();
	collectors.collectAccount.mockResolvedValue({
		repos: [],
		requests: 1,
		requestBreakdown: { graphql: 1, rest: 0 },
		partial: true,
		reasons: [],
	});
	const r5 = await startRefresh(f5.env, "account", {});
	await f5.runner.alarm();
	expect(await getRefreshRun(f5.db(), "account", r5.id)).toMatchObject({
		status: "partial",
		partialReasons: [{ repo: null, codes: ["collection:partial"] }],
	});
});

function sqlStatements(text: string): string[] {
	const statements: string[] = [];
	let lines: string[] = [];
	let trigger = false;
	for (const line of text.split("\n")) {
		lines.push(line);
		const trimmed = line.trim();
		if (/^CREATE TRIGGER/i.test(trimmed)) trigger = true;
		if (trigger && trimmed === "END;") {
			trigger = false;
			statements.push(lines.join("\n").trim());
			lines = [];
		} else if (!trigger && trimmed.endsWith(";")) {
			const statement = lines.join("\n").trim();
			if (statement) statements.push(statement);
			lines = [];
		}
	}
	const tail = lines.join("\n").trim();
	if (tail) statements.push(tail);
	return statements;
}

it("cuts a legacy active run over with the real 0030 migration and lets a real alarm finish past it", async () => {
	const fixture = await setup();
	const now = "2026-10-28T20:00:00.000Z";
	const legacyPayload = (status: string) =>
		JSON.stringify({
			id: "legacy-running",
			accountId: "account",
			status,
			phase: "repos",
			repos: ["octo/one"],
			completedRepos: 1,
			requests: 5,
			partial: false,
			errorCode: null,
			createdAt: "2026-10-28T19:00:00.000Z",
			updatedAt: now,
			finishedAt: null,
		});
	for (const trigger of [
		"refresh_run_modern_payload_insert",
		"refresh_run_modern_payload_update",
		"refresh_run_no_terminal_revive",
	]) {
		await fixture.raw.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
	}
	await fixture.raw
		.prepare(
			"INSERT INTO refresh_runs(id,account_id,status,trigger,schedule_day,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
		)
		.bind(
			"legacy-running",
			"account",
			"running",
			"manual",
			null,
			legacyPayload("running"),
			"2026-10-28T19:00:00.000Z",
			now,
		)
		.run();
	for (const statement of sqlStatements(
		readFileSync("migrations/0030_refresh_run_cancel.sql", "utf8"),
	)) {
		await fixture.raw.prepare(statement).run();
	}
	const migrated = await fixture.raw
		.prepare("SELECT status,payload FROM refresh_runs WHERE id='legacy-running'")
		.first<{ status: string; payload: string }>();
	expect(migrated?.status).toBe("failed");
	expect(JSON.parse(String(migrated?.payload))).toMatchObject({
		status: "failed",
		errorCode: "refresh_schema_cutover",
		finishedAt: now,
	});
	const fenceError = /refresh_(schema_cutover|terminal_run)/;
	await expect(
		fixture.raw
			.prepare(
				"UPDATE refresh_runs SET status=?,payload=?,updated_at=? WHERE account_id=? AND id=?",
			)
			.bind("running", legacyPayload("running"), now, "account", "legacy-running")
			.run(),
	).rejects.toThrow(fenceError);
	const run = await startRefresh(fixture.env, "account", {});
	await fixture.runner.alarm();
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "completed",
		completedRepos: 2,
	});
});

const storedAccount = (fetchedAt: string, status = "complete") => {
	const { window, calendar } = annualContributionCalendar(fetchedAt);
	return {
		schema: 1,
		account_id: "account",
		owner: "octo",
		status,
		fetched_at: fetchedAt,
		contributionStatus: "complete",
		contribution: {
			days: calendar.weeks.flatMap((week) =>
				week.contributionDays.map((day) => ({ date: day.date, count: day.contributionCount })),
			),
			total: calendar.totalContributions,
		},
		contributionObservation: { window, fetchedAt },
	};
};
async function withSavedA(fixture: Fixture, fetchedAt: string, status = "complete") {
	await fixture.raw
		.prepare(
			"INSERT INTO refresh_accounts(account_id,payload,fetched_at) VALUES('account',?,?) ON CONFLICT(account_id) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at",
		)
		.bind(JSON.stringify(storedAccount(fetchedAt, status)), fetchedAt)
		.run();
	await fixture.raw
		.prepare(
			"INSERT INTO refresh_catalog(account_id,repo_id,repo,discovered_day,timezone,payload,fetched_at,active) VALUES('account','R_1','octo/one','2026-10-28','Asia/Shanghai','{}','2026-10-28T00:00:00.000Z',1)",
		)
		.run();
}

describe("same-Shanghai-day account reuse", () => {
	beforeEach(() =>
		vi.useFakeTimers({ now: new Date("2026-10-29T04:00:00.000Z"), toFake: ["Date"] }),
	);
	afterEach(() => vi.useRealTimers());

	it("chains reused A into B, preserves timings, and recovers interrupted B start", async () => {
		const fixture = await setup();
		await withSavedA(fixture, "2026-10-29T02:00:00.000Z");
		collectors.collectRepository.mockResolvedValue(collected(0, 0, 0));
		const run = await startRefresh(fixture.env, "account", { repo: "octo/one" });
		const started = Date.now();
		await fixture.runner.alarm();
		expect(Date.now()).toBe(started);
		expect(collectors.collectAccount).not.toHaveBeenCalled();
		const saved = await getRefreshRun(fixture.db(), "account", run.id);
		expect(saved).toMatchObject({ status: "completed", requests: 0, aReused: true });
		expect(saved?.timings?.repos[0]?.startedAt).toBe(saved?.timings?.a?.finishedAt);

		const f2 = await setup();
		await withSavedA(f2, "2026-10-29T02:00:00.000Z");
		const r2 = await startRefresh(f2.env, "account", { repo: "octo/one" });
		let interrupted = false;
		await withSaveSpy(
			async (orig, db, next) => {
				if (!interrupted && next.phase === "repos" && next.timings?.repos.length === 1) {
					interrupted = true;
					throw new Error("B start persistence interrupted");
				}
				return orig(db, next);
			},
			async () => {
				await expect(f2.runner.alarm()).rejects.toThrow("B start persistence interrupted");
				expect(f2.alarmAt()).toBe(Date.now() + 5_000);
				await deliverNextAlarm(f2);
				expect(collectors.collectAccount).not.toHaveBeenCalled();
				expect(await getRefreshRun(f2.db(), "account", r2.id)).toMatchObject({
					status: "completed",
					requests: 0,
				});
			},
		);
	});

	it("recollects historical two-day A and rejects missing adhoc repos", async () => {
		const fixture = await setup();
		const fetchedAt = "2026-10-29T02:00:00.000Z";
		await withSavedA(fixture, fetchedAt);
		await fixture.raw
			.prepare("UPDATE refresh_accounts SET payload=? WHERE account_id='account'")
			.bind(
				JSON.stringify({
					...storedAccount(fetchedAt),
					contribution: {
						days: [
							{ date: "2026-10-27", count: 1 },
							{ date: "2026-10-28", count: 1 },
						],
						total: 2,
					},
					contributionObservation: {
						window: { since: "2026-10-27T00:00:00.000Z", until: "2026-10-29T00:00:00.000Z" },
						fetchedAt,
					},
				}),
			)
			.run();
		const run = await startRefresh(fixture.env, "account", { repo: "octo/one" });
		await fixture.runner.alarm();
		expect(collectors.collectAccount).toHaveBeenCalledOnce();
		expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({ aReused: false });

		const f2 = await setup();
		await withSavedA(f2, fetchedAt);
		const missing = await startRefresh(f2.env, "account", { repo: "octo/missing" });
		await f2.runner.alarm();
		expect(await getRefreshRun(f2.db(), "account", missing.id)).toMatchObject({
			status: "failed",
			errorCode: "not_found",
		});
	});

	it.each<[string, Record<string, unknown>, string, string?]>([
		["forced adhoc", { repo: "octo/one", force: true }, "2026-10-29T02:00:00.000Z"],
		["default scope", {}, "2026-10-29T02:00:00.000Z"],
		["previous Shanghai day", { repo: "octo/one" }, "2026-10-28T02:00:00.000Z"],
		["partial A", { repo: "octo/one" }, "2026-10-29T02:00:00.000Z", "partial"],
	])("refreshes A instead of reusing it for %s", async (_label, params, savedAt, status) => {
		const fixture = await setup();
		await withSavedA(fixture, savedAt, status);
		const run = await startRefresh(fixture.env, "account", params);
		await fixture.runner.alarm();
		expect(collectors.collectAccount).toHaveBeenCalledOnce();
		expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({ aReused: false });
	});

	it.each<[string, string, string, boolean]>([
		[
			"previous Shanghai day 23:59:59.999",
			"2026-10-28T15:59:59.999Z",
			"2026-10-28T16:00:00.000Z",
			false,
		],
		[
			"Shanghai midnight start of day",
			"2026-10-28T16:00:00.000Z",
			"2026-10-29T15:59:59.999Z",
			true,
		],
	])("reuse across Shanghai day boundary (%s -> %s)", async (_label, savedAt, now, reused) => {
		const fixture = await setup();
		vi.setSystemTime(new Date(now));
		await withSavedA(fixture, savedAt);
		const run = await startRefresh(fixture.env, "account", { repo: "octo/one" });
		await fixture.runner.alarm();
		expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
			status: "completed",
			aReused: reused,
			timings: { a: { reused } },
		});
	});
});

it.each(["network", "invalid-json"])(
	"persists truthful %s HTTP metadata after retry exhaustion",
	async (mode) => {
		const fixture = await setup();
		fixture.env.ENVIRONMENT = "test";
		fixture.env.GITHUB_API_BASE = "http://github.test";
		collectors.collectAccount.mockResolvedValue({ repos: ["octo/one"], ...collected(0, 0, 0) });
		collectors.collectRepository.mockImplementation(async (context) =>
			transport(context).request(
				(client) => client.githubApi(context.token, "/repos/octo/one/actions/runs"),
				"actions",
			),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				if (mode === "network") throw new TypeError("fetch failed");
				return new Response("invalid", { status: 200 });
			}),
		);
		try {
			const run = await startRefresh(fixture.env, "account", {});
			for (let attempt = 0; attempt < 4; attempt++) await deliverNextAlarm(fixture);
			expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
				status: "partial",
				partialReasons: [
					{
						repo: "octo/one",
						failures: [{ dimension: "actions", httpStatus: mode === "network" ? null : 200 }],
					},
				],
			});
		} finally {
			vi.unstubAllGlobals();
		}
	},
);

it.each(["rest", "graphql"])(
	"honors latest upstream deadline for %s rate limits",
	async (protocol) => {
		const fixture = await setup();
		fixture.env.ENVIRONMENT = "test";
		fixture.env.GITHUB_API_BASE = "http://github.test";
		const reset = Math.ceil(Date.now() / 1000) + 3600;
		collectors.collectAccount.mockResolvedValue({ repos: ["octo/one"], ...collected(0, 0, 0) });
		collectors.collectRepository.mockImplementation(async (context) =>
			transport(context).request<unknown>((client) =>
				protocol === "graphql"
					? client.githubGraphql(context.token, "query { rateLimit { resetAt } }", {})
					: client.githubApi(context.token, "/repos/octo/one/actions/runs"),
			),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json(
					protocol === "graphql"
						? { errors: [{ type: "RATE_LIMITED" }] }
						: { message: "rate limited" },
					{
						status: protocol === "graphql" ? 200 : 429,
						headers: {
							"retry-after": "120",
							"x-ratelimit-remaining": "0",
							"x-ratelimit-reset": String(reset),
						},
					},
				),
			),
		);
		try {
			const run = await startRefresh(fixture.env, "account", {});
			await fixture.runner.alarm();
			expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
				status: "running",
				errorCode: "github_rate_limited",
			});
			expect(
				((await fixture.storage.get("retry")) as { notBefore: number }).notBefore,
			).toBeGreaterThanOrEqual(reset * 1000);
		} finally {
			vi.unstubAllGlobals();
		}
	},
);

it("records timings, recovery bounds, chained wall time, single-write transitions, and backoff", async () => {
	const fixture = await setup();
	collectors.collectAccount.mockResolvedValue({
		repos: ["octo/one", "octo/two", "octo/three"],
		...collected(1, 1, 0),
	});
	const run = await startRefresh(fixture.env, "account", {});
	expect(run.timings).toMatchObject({ queuedAt: run.createdAt, a: null, repos: [] });
	expect(fixture.alarmAt() ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(Date.now());
	await fixture.restart().alarm();
	const armed = fixture.storage.setAlarm.mock.calls.map(([at]) => Number(at));
	expect(armed.length).toBeGreaterThan(2);
	for (const at of armed) expect(at).toBeLessThanOrEqual(Date.now() + 5_000);
	const timings = (await getRefreshRun(fixture.db(), "account", run.id))?.timings;
	expect(timings?.a).toMatchObject({ reused: false, attempts: 1 });
	expect(timings?.repos.map((s) => s.repo)).toEqual(["octo/one", "octo/two", "octo/three"]);

	vi.useFakeTimers({ now: new Date("2026-10-29T04:00:00.000Z"), toFake: ["Date"] });
	const f2 = await setup();
	collectors.collectAccount.mockImplementation(async () => {
		vi.setSystemTime(Date.now() + 30_000);
		return { repos: ["octo/one", "octo/two"], ...collected(1, 1, 0) };
	});
	collectors.collectRepository.mockImplementation(async () => {
		vi.setSystemTime(Date.now() + 30_000);
		return collected(3, 1, 2);
	});
	const r2 = await startRefresh(f2.env, "account", {});
	await f2.runner.alarm();
	expect(await getRefreshRun(f2.db(), "account", r2.id)).toMatchObject({
		status: "completed",
		completedRepos: 2,
	});
	vi.useRealTimers();

	const f3 = await setup();
	collectors.collectAccount.mockResolvedValue({ repos: ["octo/one"], ...collected(2, 2, 0) });
	const r3 = await startRefresh(f3.env, "account", { force: true });
	const active = vi.spyOn(refreshStore, "activeRefreshRun");
	f3.storage.setAlarm.mockClear();
	await withSaveSpy(
		(orig, db, next) => orig(db, next),
		async (save) => {
			try {
				await f3.runner.alarm();
				expect(active).toHaveBeenCalledTimes(3);
				expect(save).toHaveBeenCalledTimes(3);
				expect(f3.storage.setAlarm).toHaveBeenCalledTimes(2);
				expect(await getRefreshRun(f3.db(), "account", r3.id)).toMatchObject({
					status: "completed",
				});
			} finally {
				active.mockRestore();
			}
		},
	);
});

it("attributes exhausted repo failures, interrupted steps, and backoff cancellation timings", async () => {
	const f1 = await setup();
	const r1 = await startRefresh(f1.env, "account", {});
	collectors.collectRepository.mockRejectedValue(
		new ApiError(502, "github_error", "upstream secret detail", null, 502),
	);
	for (let attempt = 0; attempt < 4; attempt++) await deliverNextAlarm(f1);
	collectors.collectRepository.mockResolvedValue(collected(3, 1, 2));
	await deliverNextAlarm(f1);
	expect(await getRefreshRun(f1.db(), "account", r1.id)).toMatchObject({
		status: "partial",
		completedRepos: 2,
		partialReasons: [
			{ repo: "octo/one", codes: ["github_error"], failures: [{ httpStatus: 502 }] },
		],
	});
	expect(
		JSON.stringify((await f1.raw.prepare("SELECT payload FROM refresh_runs").all()).results),
	).not.toContain("upstream secret detail");

	const f2 = await setup();
	collectors.collectAccount.mockClear();
	const r2 = await startRefresh(f2.env, "account", {});
	const inFlight = await deferredCollection();
	const step = f2.runner.alarm();
	const { release } = await inFlight();
	expect(await getRefreshRun(f2.db(), "account", r2.id)).toMatchObject({
		status: "running",
		timings: { repos: [{ repo: "octo/one", finishedAt: null, attempts: 0 }] },
	});
	expect((f2.alarmAt() ?? Number.POSITIVE_INFINITY) - Date.now()).toBeLessThanOrEqual(5_000);
	release(collected(3, 1, 2));
	await step;

	const f3 = await setup();
	resetCollectors();
	const r3 = await startRefresh(f3.env, "account", {});
	collectors.collectAccount.mockRejectedValueOnce(new ApiError(502, "github_error", "safe"));
	await f3.runner.alarm();
	expect((await f3.cancelRequest(r3.id)).status).toBe(202);
	await f3.runner.alarm();
	const c3 = await getRefreshRun(f3.db(), "account", r3.id);
	expect(c3).toMatchObject({ status: "cancelled", errorCode: "github_error" });
	expect(c3?.timings?.a?.finishedAt).toBe(c3?.finishedAt);

	const f4 = await setup();
	collectors.collectAccount.mockClear();
	const r4 = await startRefresh(f4.env, "account", {});
	collectors.collectRepository.mockRejectedValue(rateLimitError(120_000, 429));
	await f4.runner.alarm();
	expect((await f4.cancelRequest(r4.id)).status).toBe(202);
	await f4.runner.alarm();
	const c4 = await getRefreshRun(f4.db(), "account", r4.id);
	expect(c4).toMatchObject({
		status: "cancelled",
		errorCode: "github_rate_limited",
		partialReasons: [
			{ repo: "octo/one", failures: [{ code: "github_rate_limited", httpStatus: 429 }] },
		],
	});
	expect(c4?.timings?.repos[0]?.finishedAt).toBe(c4?.finishedAt);
});

it.each([false, true])(
	"preserves rate-limit deadlines through an interrupted alarm write (cancel=%s)",
	async (cancel) => {
		vi.useFakeTimers({ now: new Date("2026-10-29T04:00:00.000Z"), toFake: ["Date"] });
		const fixture = await setup();
		const run = await startRefresh(fixture.env, "account", {});
		const deadline = Date.now() + 120_000;
		collectors.collectAccount.mockImplementationOnce(async () => {
			fixture.storage.setAlarm.mockRejectedValueOnce(new Error("alarm write interrupted"));
			throw new ApiError(503, "github_rate_limited", "safe", new Date(deadline).toISOString(), 429);
		});
		await expect(fixture.runner.alarm()).rejects.toThrow("alarm write interrupted");
		vi.setSystemTime(Date.now() + 5_000);
		if (cancel) await fixture.cancelRequest(run.id);
		await fixture.restart().alarm();
		if (cancel) {
			expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
				status: "cancelled",
			});
			expect(fixture.alarmAt()).toBeNull();
		} else {
			expect(await fixture.storage.get("retry")).toMatchObject({ notBefore: deadline });
			vi.setSystemTime(deadline - 1);
			await fixture.restart().alarm();
			expect(collectors.collectAccount).toHaveBeenCalledTimes(1);
			vi.setSystemTime(deadline);
			await fixture.restart().alarm();
			expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
				status: "completed",
			});
		}
	},
);

it.each([
	["account", false],
	["account", true],
	["repos", false],
	["repos", true],
] as const)(
	"recovers exhausted %s settlement without another request after D1 failure (cancel=%s)",
	async (phase, cancel) => {
		vi.useFakeTimers({ now: new Date("2026-10-29T04:00:00.000Z"), toFake: ["Date"] });
		const fixture = await setup();
		collectors.collectAccount.mockResolvedValue({ repos: ["octo/one"], ...collected(1, 1, 0) });
		const collector =
			phase === "account" ? collectors.collectAccount : collectors.collectRepository;
		const path = phase === "account" ? ["viewer", "repositories"] : ["repository", "issues"];
		collector.mockImplementation(async (context) =>
			transport(context).request(async (client) => {
				client.count = 1;
				client.requests.graphql = 1;
				client.graphqlErrors.push({ type: "RATE_LIMITED", path });
				throw rateLimitError(120_000, 429);
			}),
		);
		const run = await startRefresh(fixture.env, "account", {});
		for (let attempt = 0; attempt < 3; attempt++) await deliverNextAlarm(fixture);
		let interrupted = false;
		await withSaveSpy(
			async (orig, db, next) => {
				if (!interrupted && ["failed", "partial"].includes(next.status)) {
					interrupted = true;
					throw new Error("terminal settlement interrupted");
				}
				return orig(db, next);
			},
			async () => {
				await expect(deliverNextAlarm(fixture)).rejects.toThrow("terminal settlement interrupted");
				const failedAt = new Date().toISOString();
				expect(collector).toHaveBeenCalledTimes(4);
				vi.setSystemTime(Date.now() + 5_000);
				if (cancel) await fixture.cancelRequest(run.id);
				await fixture.restart().alarm();
				expect(collector).toHaveBeenCalledTimes(4);
				const finished = await getRefreshRun(fixture.db(), "account", run.id);
				expect(finished).toMatchObject({
					status: cancel ? "cancelled" : phase === "account" ? "failed" : "partial",
					errorCode: "github_rate_limited",
					partialReasons: [
						{
							repo: phase === "account" ? null : "octo/one",
							failures: [
								{
									dimension: phase === "account" ? "catalog" : "issues",
									graphqlType: "RATE_LIMITED",
									graphqlPath: path,
									httpStatus: 429,
								},
							],
						},
					],
				});
				expect(
					phase === "account" ? finished?.timings?.a : finished?.timings?.repos[0],
				).toMatchObject({
					attempts: 4,
					finishedAt: failedAt,
				});
			},
		);
	},
);

it.each(["committed-save", "retry-delete"])(
	"fences exhausted repo/terminal markers after %s acknowledgement fails",
	async (boundary) => {
		const f1 = await setup();
		collectors.collectRepository.mockImplementation(async (context, repo) => {
			if (repo === "octo/two") return collected(3, 1, 2);
			context.onRequests(1, { graphql: 1, rest: 0 });
			throw rateLimitError();
		});
		const r1 = await startRefresh(f1.env, "account", {});
		for (let attempt = 0; attempt < 3; attempt++) await deliverNextAlarm(f1);
		let int1 = false;
		await withSaveSpy(
			async (orig, db, next) => {
				const saved = await orig(db, next);
				if (!int1 && next.completedRepos === 1) {
					int1 = true;
					if (boundary === "committed-save") throw new Error("settlement acknowledgement lost");
					f1.storage.delete.mockRejectedValueOnce(new Error("settlement acknowledgement lost"));
				}
				return saved;
			},
			async () => {
				await expect(deliverNextAlarm(f1)).rejects.toThrow("settlement acknowledgement lost");
				await deliverNextAlarm(f1);
				expect(collectors.collectRepository.mock.calls.map(([, repo]) => repo)).toEqual([
					"octo/one",
					"octo/one",
					"octo/one",
					"octo/one",
					"octo/two",
				]);
				expect(await getRefreshRun(f1.db(), "account", r1.id)).toMatchObject({
					status: "partial",
					completedRepos: 2,
				});
			},
		);

		const f2 = await setup();
		collectors.collectAccount.mockImplementation(async (context) => {
			context.onRequests(1, { graphql: 1, rest: 0 });
			throw rateLimitError();
		});
		const r2 = await startRefresh(f2.env, "account", {});
		for (let attempt = 0; attempt < 3; attempt++) await deliverNextAlarm(f2);
		let int2 = false;
		await withSaveSpy(
			async (orig, db, next) => {
				const saved = await orig(db, next);
				if (!int2 && next.status === "failed") {
					int2 = true;
					if (boundary === "committed-save") throw new Error("terminal acknowledgement lost");
					f2.storage.delete.mockRejectedValueOnce(new Error("terminal acknowledgement lost"));
				}
				return saved;
			},
			async () => {
				await expect(deliverNextAlarm(f2)).rejects.toThrow("terminal acknowledgement lost");
				const terminal = await getRefreshRun(f2.db(), "account", r2.id);
				expect(terminal).toMatchObject({ status: "failed", requests: 4 });
				if (boundary === "retry-delete") await deliverNextAlarm(f2);
				collectors.collectAccount.mockResolvedValue({ repos: [], ...collected(1, 1, 0) });
				const next = await startRefresh(f2.env, "account", {});
				await deliverNextAlarm(f2);
				expect(await getRefreshRun(f2.db(), "account", r2.id)).toEqual(terminal);
				expect(await getRefreshRun(f2.db(), "account", next.id)).toMatchObject({
					status: "completed",
					errorCode: null,
				});
			},
		);
	},
);

it.each([false, true])(
	"retains retry until successful D1 settlement and rearms exhausted failures (cancel=%s)",
	async (cancel) => {
		const f1 = await setup();
		collectors.collectAccount
			.mockRejectedValueOnce(new ApiError(502, "github_error", "safe"))
			.mockResolvedValue({ repos: [], ...collected(1, 1, 0) });
		const r1 = await startRefresh(f1.env, "account", {});
		await f1.runner.alarm();
		if (cancel) await f1.cancelRequest(r1.id);
		let int1 = false;
		await withSaveSpy(
			async (orig, db, next) => {
				if (!int1 && ["completed", "cancelled"].includes(next.status)) {
					int1 = true;
					throw new Error("D1 unavailable");
				}
				return orig(db, next);
			},
			async () => {
				await expect(deliverNextAlarm(f1)).rejects.toThrow("D1 unavailable");
				await deliverNextAlarm(f1);
				expect(await getRefreshRun(f1.db(), "account", r1.id)).toMatchObject({
					status: cancel ? "cancelled" : "completed",
				});
			},
		);

		const f2 = await setup();
		collectors.collectAccount.mockClear();
		collectors.collectAccount.mockRejectedValue(new ApiError(503, "github_rate_limited", "safe"));
		const r2 = await startRefresh(f2.env, "account", {});
		for (let attempt = 0; attempt < 3; attempt++) await deliverNextAlarm(f2);
		let failures = 3;
		await withSaveSpy(
			async (orig, db, next) => {
				if (["failed", "cancelled"].includes(next.status) && failures-- > 0) {
					throw new Error("settlement still unavailable");
				}
				return orig(db, next);
			},
			async () => {
				await expect(deliverNextAlarm(f2)).rejects.toThrow("settlement still unavailable");
				if (cancel) await f2.cancelRequest(r2.id);
				for (let replay = 0; replay < 2; replay++) {
					await expect(deliverNextAlarm(f2)).rejects.toThrow("settlement still unavailable");
					expect(collectors.collectAccount).toHaveBeenCalledTimes(4);
				}
				await deliverNextAlarm(f2);
				expect(await getRefreshRun(f2.db(), "account", r2.id)).toMatchObject({
					status: cancel ? "cancelled" : "failed",
				});
			},
		);
	},
);

it("clears resolved failure code, drains large runs across D1 budget, and attributes exhausted cancellation", async () => {
	const f1 = await setup();
	collectors.collectAccount.mockResolvedValue({ repos: ["octo/one"], ...collected(1, 1, 0) });
	collectors.collectRepository
		.mockRejectedValueOnce(new ApiError(502, "github_error", "safe"))
		.mockResolvedValue(collected(3, 1, 2));
	const r1 = await startRefresh(f1.env, "account", {});
	await f1.runner.alarm();
	expect(await getRefreshRun(f1.db(), "account", r1.id)).toMatchObject({
		errorCode: "github_error",
		status: "running",
	});
	await deliverNextAlarm(f1);
	expect(await getRefreshRun(f1.db(), "account", r1.id)).toMatchObject({
		status: "completed",
		errorCode: null,
		partial: false,
	});

	for (const count of [1, 2]) {
		const f2 = await setup();
		collectors.collectAccount.mockResolvedValue({
			repos: ["octo/one", "octo/two"].slice(0, count),
			...collected(1, 1, 0),
		});
		const r2 = await startRefresh(f2.env, "account", {});
		collectors.collectRepository.mockRejectedValue(new ApiError(502, "github_error", "safe"));
		for (let attempt = 0; attempt < 3; attempt++) await deliverNextAlarm(f2);
		collectors.collectRepository.mockImplementationOnce(async () => {
			await f2.cancelRequest(r2.id);
			throw new ApiError(502, "github_error", "safe");
		});
		await deliverNextAlarm(f2);
		const saved = await getRefreshRun(f2.db(), "account", r2.id);
		expect(saved).toMatchObject({ status: "cancelled", completedRepos: 1 });
		expect(saved?.partialReasons.map((reason) => reason.repo)).toEqual(["octo/one"]);
	}

	const f3 = await setup();
	const repos = Array.from({ length: 35 }, (_, index) => `octo/repo-${index}`);
	collectors.collectAccount.mockResolvedValue({ repos, ...collected(0, 0, 0) });
	collectors.collectRepository.mockResolvedValue(collected(0, 0, 0));
	const r3 = await startRefresh(f3.env, "account", {});
	await f3.runner.alarm();
	expect(await getRefreshRun(f3.db(), "account", r3.id)).toMatchObject({
		status: "running",
		completedRepos: 29,
	});
	await f3.restart().alarm();
	expect(await getRefreshRun(f3.db(), "account", r3.id)).toMatchObject({
		status: "completed",
		completedRepos: 35,
	});
});
