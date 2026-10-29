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
beforeEach(() => {
	collectors.collectAccount.mockReset().mockResolvedValue({
		repos: ["octo/one", "octo/two"],
		...collected(1, 1, 0),
	});
	collectors.collectRepository.mockReset().mockResolvedValue(collected(3, 1, 2));
});
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
async function deliverNextAlarm(fixture: Awaited<ReturnType<typeof setup>>) {
	vi.useFakeTimers({ now: Math.max(Date.now(), fixture.alarmAt() ?? 0), toFake: ["Date"] });
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
		return {
			release: (value: unknown) => release?.(value),
		};
	};
}
it("durably queues one account run and executes A then B serial across restarts", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	expect(run.status).toBe("queued");
	expect(collectors.collectAccount).not.toHaveBeenCalled();
	expect((await startRefresh(fixture.env, "account", {})).id).toBe(run.id);
	await fixture.restart().alarm();
	expect(collectors.collectAccount).toHaveBeenCalledOnce();
	expect(collectors.collectRepository.mock.calls.map((call) => call[1])).toEqual([
		"octo/one",
		"octo/two",
	]);
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
});
it("does not execute B after account failure or persist raw failure details", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	collectors.collectAccount.mockRejectedValue(
		new ApiError(401, "github_unauthorized", fixture.token),
	);
	await fixture.runner.alarm();
	expect(collectors.collectRepository).not.toHaveBeenCalled();
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "failed",
		errorCode: "github_unauthorized",
	});
});
it("retries transient failures with durable bounded attempts then continues other repos", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	collectors.collectRepository.mockRejectedValue(
		new ApiError(503, "github_rate_limited", "safe", new Date(Date.now() + 120_000).toISOString()),
	);
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
it("deduplicates scheduled deliveries after completion and idles without an account", async () => {
	const fixture = await setup();
	await fixture.runner.alarm();
	collectors.collectAccount.mockResolvedValue({ repos: [], ...collected(1, 1, 0) });
	const at = new Date("2026-10-28T19:00:00.000Z");
	const run = await startRefresh(fixture.env, "account", {}, "scheduled", at);
	await fixture.runner.alarm();
	expect((await startRefresh(fixture.env, "account", {}, "scheduled", at)).id).toBe(run.id);
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "completed",
	});
	await fixture.runner.alarm();
});
it("rejects unknown accounts and unsupported internal methods safely", async () => {
	const fixture = await setup();
	await expect(startRefresh(fixture.env, "missing", {})).rejects.toMatchObject({
		code: "account_missing",
	});
	expect((await fixture.runner.fetch(new Request("https://refresh.internal"))).status).toBe(405);
});
it("queues the daily schedule behind an adhoc run without losing either request", async () => {
	const fixture = await setup();
	collectors.collectAccount.mockResolvedValue({ repos: [], ...collected(1, 1, 0) });
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
	expect(await getRefreshRun(fixture.db(), "account", adhoc.id)).toMatchObject({
		status: "completed",
	});
});
it("fails closed for missing bindings, malformed starts and account identity reuse", async () => {
	const fixture = await setup();
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
	await fixture.raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('other','other','fake','fake','t','t')",
		)
		.run();
	await expect(startRefresh(fixture.env, "other", {})).rejects.toMatchObject({
		code: "validation_failed",
	});
});
it("schedules the account using the cron timestamp and never starts collection inline", async () => {
	const fixture = await setup();
	await scheduleRefresh(fixture.env, Date.parse("2026-10-28T19:00:00.000Z"));
	expect(collectors.collectAccount).not.toHaveBeenCalled();
	expect(
		(await fixture.raw.prepare("SELECT schedule_day,status FROM refresh_runs").all()).results,
	).toEqual([{ schedule_day: "2026-10-29", status: "queued" }]);
	await fixture.raw.prepare("DELETE FROM accounts").run();
	await scheduleRefresh(fixture.env, Date.now());
});
it("stops safely if encrypted credentials or a repository cursor are invalid", async () => {
	const fixture = await setup();
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
});
it("bounds unknown repository failures, rejects invalid retry timestamps and publishes partial completion", async () => {
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
});

it("preserves retry deadlines for duplicate, conflicting and queued schedule starts", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	collectors.collectAccount.mockRejectedValueOnce(
		new ApiError(503, "github_rate_limited", "safe", new Date(Date.now() + 120_000).toISOString()),
	);
	await fixture.runner.alarm();
	const alarms = fixture.storage.setAlarm.mock.calls.length;
	expect((await startRefresh(fixture.env, "account", {})).id).toBe(run.id);
	await expect(startRefresh(fixture.env, "account", { force: true })).rejects.toMatchObject({
		code: "refresh_conflict",
	});
	await startRefresh(fixture.env, "account", {}, "scheduled");
	expect(fixture.storage.setAlarm).toHaveBeenCalledTimes(alarms);
	collectors.collectAccount.mockResolvedValue({ repos: [], ...collected(1, 1, 0) });
	await deliverNextAlarm(fixture);
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "completed",
		errorCode: null,
	});
});

it("counts failed upstream attempts without treating durable steps as requests", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	collectors.collectAccount.mockImplementationOnce(async (context) => {
		context.onRequests(2, { graphql: 2, rest: 0 });
		throw new ApiError(502, "github_error", "safe");
	});
	await fixture.runner.alarm();
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		requests: 2,
		requestBreakdown: { total: 2, graphql: 2, rest: 0, a: { graphql: 2, rest: 0 } },
	});
	collectors.collectAccount.mockResolvedValue({ repos: [], ...collected(1, 0, 1) });
	await deliverNextAlarm(fixture);
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		requests: 3,
		requestBreakdown: { total: 3, graphql: 2, rest: 1, a: { graphql: 2, rest: 1 } },
		status: "completed",
	});
});

it("does not retry an adhoc repository absent from the refreshed catalogue", async () => {
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
	expect(collectors.collectRepository).not.toHaveBeenCalled();
});

it("serializes idle cleanup with incoming starts so new queued work retains its alarm", async () => {
	const fixture = await setup();
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
	expect(fixture.alarmAt()).not.toBeNull();
	await fixture.runner.alarm();
	expect(await getRefreshRun(fixture.db(), "account", queued?.id ?? "")).toMatchObject({
		status: "completed",
	});
});

it("continues scheduling other accounts after a failure and only reports safe aggregate errors", async () => {
	const fixture = await setup();
	await fixture.raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('second','second','fake','fake','t','t')",
		)
		.run();
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(Response.json({ error: { code: fixture.token } }, { status: 503 }))
		.mockResolvedValueOnce(Response.json({ id: "second-run" }, { status: 202 }));
	const getByName = vi.fn(() => ({ fetch }));
	fixture.env.REFRESH_RUNNER = { getByName } as unknown as DurableObjectNamespace;
	await expect(scheduleRefresh(fixture.env, Date.now())).rejects.toMatchObject({
		code: "refresh_schedule_failed",
		message: "1 account schedules failed",
	});
	expect(getByName.mock.calls).toEqual([["account"], ["second"]]);
});

it("cancels a running run after the current repository, keeping its data", async () => {
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
		repos: ["octo/one", "octo/two"],
	});
	release(collected(3, 1, 2));
	await step;
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "cancelled",
		phase: "done",
		cancelRequested: true,
		completedRepos: 1,
		requests: 4,
		requestBreakdown: { total: 4, graphql: 2, rest: 2, a: { graphql: 1, rest: 0 } },
	});
	expect(collectors.collectRepository).toHaveBeenCalledOnce();
	await fixture.runner.alarm();
	expect(collectors.collectRepository).toHaveBeenCalledOnce();
	expect(fixture.alarmAt()).toBeNull();
});

it.each(["account", "repos"] as const)(
	"preserves accepted cancellation when the current %s step fails fatally",
	async (phase) => {
		const fixture = await setup();
		const run = await startRefresh(fixture.env, "account", {});
		if (phase === "repos")
			await saveRefreshRun(fixture.db(), {
				...run,
				phase: "repos",
				repos: ["octo/one"],
			});
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
		const accepted = await fixture.cancelRequest(run.id);
		expect(accepted.status).toBe(202);
		expect(await accepted.json()).toMatchObject({ cancelRequested: true, status: "running" });
		rejectCollection?.(new ApiError(401, "github_unauthorized", "safe", null, 401));
		await step;
		const cancelled = await getRefreshRun(fixture.db(), "account", run.id);
		expect(cancelled).toMatchObject({
			status: "cancelled",
			phase: "done",
			cancelRequested: true,
			completedRepos: 0,
			errorCode: "github_unauthorized",
			requests: 1,
			partialReasons: [
				{
					repo: phase === "repos" ? "octo/one" : null,
					codes: ["github_unauthorized"],
					failures: [
						{
							dimension: null,
							code: "github_unauthorized",
							httpStatus: 401,
							graphqlType: null,
							graphqlPath: null,
						},
					],
				},
			],
		});
		expect(await (await fixture.cancelRequest(run.id)).json()).toEqual(cancelled);
		await fixture.runner.alarm();
		expect(collector).toHaveBeenCalledOnce();
		expect(fixture.alarmAt()).toBeNull();
	},
);

it("cancels a queued run without any account work and still wakes the queued schedule", async () => {
	const fixture = await setup();
	collectors.collectAccount.mockResolvedValue({ repos: [], ...collected(1, 1, 0) });
	const adhoc = await startRefresh(fixture.env, "account", { repo: "octo/one" });
	const scheduled = await startRefresh(fixture.env, "account", {}, "scheduled");
	const response = await fixture.cancelRequest(adhoc.id);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		status: "cancelled",
		phase: "done",
		completedRepos: 0,
		requests: 0,
		cancelRequested: true,
	});
	expect(collectors.collectAccount).not.toHaveBeenCalled();
	await fixture.runner.alarm();
	expect(collectors.collectAccount).toHaveBeenCalledOnce();
	expect(await getRefreshRun(fixture.db(), "account", scheduled.id)).toMatchObject({
		status: "completed",
	});
	expect((await getRefreshRun(fixture.db(), "account", adhoc.id))?.status).toBe("cancelled");
});

it("cancels idempotently and reports terminal runs or fenced identifiers explicitly", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	const inFlight = await deferredCollection();
	const step = fixture.runner.alarm();
	const { release } = await inFlight();
	const accepted = await fixture.cancelRequest(run.id);
	expect(accepted.status).toBe(202);
	expect((await accepted.json()) as { cancelRequested: boolean }).toMatchObject({
		cancelRequested: true,
	});
	release(collected(3, 1, 2));
	await step;
	const first = await fixture.cancelRequest(run.id);
	expect(first.status).toBe(200);
	const terminal = (await first.json()) as { status: string; completedRepos: number };
	expect(terminal).toMatchObject({ status: "cancelled", completedRepos: 1 });
	expect(await (await fixture.cancelRequest(run.id)).json()).toEqual(terminal);
	const completed = await startRefresh(fixture.env, "account", {});
	await fixture.runner.alarm();
	expect(
		(await (await fixture.cancelRequest(completed.id)).json()) as { status: string },
	).toMatchObject({ status: "completed" });
	expect((await fixture.cancelRequest("missing")).status).toBe(404);
	await fixture.raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('other','other','fake','fake','t','t')",
		)
		.run();
	expect((await fixture.cancelRequest(run.id, "other")).status).toBe(400);
	expect((await fixture.cancelRequest("missing", "missing")).status).toBe(404);
});

it("stops retry backoff when cancel arrives and never retries the failed repository", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	collectors.collectRepository.mockRejectedValueOnce(
		new ApiError(503, "github_rate_limited", "safe", new Date(Date.now() + 120_000).toISOString()),
	);
	await fixture.runner.alarm();
	expect(fixture.alarmAt()).toBeGreaterThan(Date.now() + 60_000);
	expect((await fixture.cancelRequest(run.id)).status).toBe(202);
	expect(fixture.alarmAt()).toBeLessThanOrEqual(Date.now() + 1_000);
	await fixture.runner.alarm();
	expect(collectors.collectRepository).toHaveBeenCalledOnce();
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "cancelled",
		completedRepos: 0,
		requests: 1,
	});
	expect(fixture.storage.delete).toHaveBeenCalledWith("retry");
});

it("never resurrects a cancelled run when a concurrent alarm finalizes it first", async () => {
	const fixture = await setup();
	collectors.collectAccount.mockResolvedValue({
		repos: ["octo/one"],
		...collected(1, 1, 0),
	});
	const run = await startRefresh(fixture.env, "account", {});
	const inFlight = await deferredCollection();
	const step = fixture.runner.alarm();
	const { release } = await inFlight();
	expect((await fixture.cancelRequest(run.id)).status).toBe(202);
	await fixture.runner.alarm();
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "cancelled",
		completedRepos: 0,
	});
	release(collected(3, 1, 2));
	await step;
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "cancelled",
		phase: "done",
		cancelRequested: true,
		completedRepos: 1,
		requests: 4,
		requestBreakdown: { total: 4, graphql: 2, rest: 2 },
	});
	expect(fixture.alarmAt()).toBeNull();
});

it("returns the same run from the public cancel helper and fences unknown accounts", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	expect((await cancelRefresh(fixture.env, "account", run.id)).status).toBe("cancelled");
	await expect(cancelRefresh(fixture.env, "missing", run.id)).rejects.toMatchObject({
		code: "account_missing",
	});
	const { REFRESH_RUNNER: _binding, ...withoutBinding } = fixture.env;
	await expect(cancelRefresh(withoutBinding, "account", run.id)).rejects.toMatchObject({
		code: "refresh_unavailable",
	});
});

it("does not disturb an in-flight step when a queued run is cancelled", async () => {
	const fixture = await setup();
	const running = await startRefresh(fixture.env, "account", {});
	const inFlight = await deferredCollection();
	const step = fixture.runner.alarm();
	const { release } = await inFlight();
	const scheduled = await startRefresh(fixture.env, "account", {}, "scheduled");
	const safetyAlarm = fixture.alarmAt();
	expect((await fixture.cancelRequest(scheduled.id)).status).toBe(200);
	expect(fixture.alarmAt()).toBe(safetyAlarm);
	release(collected(3, 1, 2));
	await step;
	expect(await getRefreshRun(fixture.db(), "account", scheduled.id)).toMatchObject({
		status: "cancelled",
	});
	expect(await getRefreshRun(fixture.db(), "account", running.id)).toMatchObject({
		completedRepos: 2,
	});
	await fixture.runner.alarm();
	expect(await getRefreshRun(fixture.db(), "account", running.id)).toMatchObject({
		status: "completed",
		partialReasons: [],
	});
});

it("never marks a run partial without a reason code", async () => {
	const fixture = await setup();
	collectors.collectAccount.mockResolvedValue({
		repos: [],
		requests: 1,
		requestBreakdown: { graphql: 1, rest: 0 },
		partial: true,
		reasons: [],
	});
	const run = await startRefresh(fixture.env, "account", {});
	await fixture.runner.alarm();
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "partial",
		partialReasons: [{ repo: null, codes: ["collection:partial"] }],
	});
});

const legacyRun = (id: string, status: string) =>
	JSON.stringify({
		id,
		accountId: "account",
		status,
		phase: "repos",
		repos: ["octo/one"],
		completedRepos: 1,
		requests: 5,
		partial: false,
		errorCode: null,
		createdAt: "2026-10-28T19:00:00.000Z",
		updatedAt: "2026-10-28T20:00:00.000Z",
		finishedAt: null,
	});
const oldSaveRun =
	"UPDATE refresh_runs SET status=?,payload=?,updated_at=? WHERE account_id=? AND id=?";
const oldInsertRun =
	"INSERT INTO refresh_runs(id,account_id,status,trigger,schedule_day,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)";
const fenceError = /refresh_(schema_cutover|terminal_run)/;
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
	for (const trigger of [
		"refresh_run_modern_payload_insert",
		"refresh_run_modern_payload_update",
		"refresh_run_no_terminal_revive",
	])
		await fixture.raw.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
	const oldSave = (status: string) =>
		fixture.raw
			.prepare(oldSaveRun)
			.bind(status, legacyRun("legacy-running", status), now, "account", "legacy-running")
			.run();
	await fixture.raw
		.prepare(oldInsertRun)
		.bind(
			"legacy-running",
			"account",
			"running",
			"manual",
			null,
			legacyRun("legacy-running", "running"),
			"2026-10-28T19:00:00.000Z",
			now,
		)
		.run();
	await expect(oldSave("running")).resolves.toMatchObject({ success: true });
	await fixture.raw
		.prepare(
			"INSERT INTO refresh_day_observations(account_id,repo_id,timezone,day,dimension,status,payload,fetched_at) VALUES('account','R_APP','Asia/Shanghai','2026-10-28','commits','complete','{}',?)",
		)
		.bind(now)
		.run();
	for (const statement of sqlStatements(
		readFileSync("migrations/0030_refresh_run_cancel.sql", "utf8"),
	))
		await fixture.raw.prepare(statement).run();
	const migrated = await fixture.raw
		.prepare("SELECT status,payload FROM refresh_runs WHERE id='legacy-running'")
		.first<{ status: string; payload: string }>();
	expect(migrated?.status).toBe("failed");
	const legacy = JSON.parse(String(migrated?.payload)) as Record<string, unknown>;
	expect(legacy).toMatchObject({
		id: "legacy-running",
		status: "failed",
		phase: "done",
		errorCode: "refresh_schema_cutover",
		requests: 5,
		repos: ["octo/one"],
		completedRepos: 1,
		finishedAt: now,
	});
	expect(legacy.requestBreakdown).toBeUndefined();
	await expect(oldSave("running")).rejects.toThrow(fenceError);
	await expect(oldSave("completed")).rejects.toThrow(fenceError);
	await expect(
		fixture.raw
			.prepare(oldInsertRun)
			.bind(
				"legacy-new",
				"account",
				"queued",
				"manual",
				null,
				legacyRun("legacy-new", "queued"),
				now,
				now,
			)
			.run(),
	).rejects.toThrow(fenceError);
	const run = await startRefresh(fixture.env, "account", {});
	expect(run.status).toBe("queued");
	expect(run.id).not.toBe("legacy-running");
	await fixture.runner.alarm();
	expect(collectors.collectAccount).toHaveBeenCalledOnce();
	await expect(oldSave("running")).rejects.toThrow(fenceError);
	await fixture.runner.alarm();
	await expect(oldSave("completed")).rejects.toThrow(fenceError);
	await fixture.runner.alarm();
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
	expect(await getRefreshRun(fixture.db(), "account", "legacy-running")).toMatchObject({
		status: "failed",
		errorCode: "refresh_schema_cutover",
		completedRepos: 1,
	});
	expect(
		await fixture.raw
			.prepare(
				"SELECT repo_id,dimension,status FROM refresh_day_observations WHERE account_id='account'",
			)
			.all(),
	).toMatchObject({ results: [{ repo_id: "R_APP", dimension: "commits", status: "complete" }] });
	expect(fixture.alarmAt()).toBeNull();
	await fixture.runner.alarm();
	expect(collectors.collectAccount).toHaveBeenCalledOnce();
	expect((await startRefresh(fixture.env, "account", {})).status).toBe("queued");
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
async function withSavedA(
	fixture: Awaited<ReturnType<typeof setup>>,
	fetchedAt: string,
	status = "complete",
) {
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

	it("chains reused A directly into zero-request B without delivering the recovery alarm", async () => {
		const fixture = await setup();
		await withSavedA(fixture, "2026-10-29T02:00:00.000Z");
		collectors.collectRepository.mockResolvedValue(collected(0, 0, 0));
		const run = await startRefresh(fixture.env, "account", { repo: "octo/one" });
		const started = Date.now();
		await fixture.runner.alarm();
		expect(Date.now()).toBe(started);
		expect(collectors.collectAccount).not.toHaveBeenCalled();
		expect(collectors.collectRepository).toHaveBeenCalledOnce();
		const saved = await getRefreshRun(fixture.db(), "account", run.id);
		expect(saved).toMatchObject({ status: "completed", requests: 0, aReused: true });
		expect(saved?.timings?.repos[0]?.startedAt).toBe(saved?.timings?.a?.finishedAt);
		expect(fixture.alarmAt()).toBeNull();
	});

	it("recovers an interrupted first B start without a five-minute zero-request idle", async () => {
		const fixture = await setup();
		await withSavedA(fixture, "2026-10-29T02:00:00.000Z");
		collectors.collectRepository.mockResolvedValue(collected(0, 0, 0));
		const run = await startRefresh(fixture.env, "account", { repo: "octo/one" });
		const original = refreshStore.saveRefreshRun;
		let interrupted = false;
		const save = vi.spyOn(refreshStore, "saveRefreshRun").mockImplementation(async (db, next) => {
			if (!interrupted && next.phase === "repos" && next.timings?.repos.length === 1) {
				interrupted = true;
				throw new Error("B start persistence interrupted");
			}
			await original(db, next);
		});
		try {
			await expect(fixture.runner.alarm()).rejects.toThrow("B start persistence interrupted");
			expect(collectors.collectRepository).not.toHaveBeenCalled();
			expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
				status: "running",
				phase: "account",
				requests: 0,
				aReused: false,
				timings: { repos: [] },
			});
			expect(fixture.alarmAt()).toBe(Date.now() + 5_000);
			await deliverNextAlarm(fixture);
			expect(collectors.collectAccount).not.toHaveBeenCalled();
			expect(collectors.collectRepository).toHaveBeenCalledOnce();
			expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
				status: "completed",
				requests: 0,
			});
		} finally {
			save.mockRestore();
		}
	});

	it("reuses a same-day successful A for an adhoc repository without renewing its evidence", async () => {
		const fixture = await setup();
		await withSavedA(fixture, "2026-10-29T02:00:00.000Z");
		const run = await startRefresh(fixture.env, "account", { repo: "octo/one" });
		expect(run.params.repo).toBe("octo/one");
		await fixture.runner.alarm();
		expect(collectors.collectAccount).not.toHaveBeenCalled();
		expect(collectors.collectRepository.mock.calls[0]?.[1]).toBe("octo/one");
		expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
			status: "completed",
			aReused: true,
			repos: ["octo/one"],
			requests: 3,
			requestBreakdown: { total: 3, graphql: 1, rest: 2, a: { graphql: 0, rest: 0 } },
			timings: {
				queuedAt: run.createdAt,
				a: { reused: true, attempts: 1, finishedAt: expect.any(String) },
				repos: [{ repo: "octo/one", attempts: 1, finishedAt: expect.any(String) }],
			},
			finishedAt: expect.any(String),
		});
		const account = await fixture.raw
			.prepare("SELECT fetched_at FROM refresh_accounts WHERE account_id='account'")
			.first<{ fetched_at: string }>();
		expect(account?.fetched_at).toBe("2026-10-29T02:00:00.000Z");
	});

	it("recollects a declared-complete historical A containing only two calendar days", async () => {
		const fixture = await setup();
		const fetchedAt = "2026-10-29T02:00:00.000Z";
		await withSavedA(fixture, fetchedAt);
		const historical = {
			...storedAccount(fetchedAt),
			contributionStatus: "complete",
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
		};
		await fixture.raw
			.prepare("UPDATE refresh_accounts SET payload=? WHERE account_id='account'")
			.bind(JSON.stringify(historical))
			.run();
		const run = await startRefresh(fixture.env, "account", { repo: "octo/one" });
		await fixture.runner.alarm();
		expect(collectors.collectAccount).toHaveBeenCalledOnce();
		expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({ aReused: false });
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
		expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
			aReused: false,
		});
	});

	it.each<[string, string, string, boolean]>([
		[
			"a saved A ending the previous Shanghai day at 23:59:59.999",
			"2026-10-28T15:59:59.999Z",
			"2026-10-28T16:00:00.000Z",
			false,
		],
		[
			"a saved A at the Shanghai midnight that starts the run's day",
			"2026-10-28T16:00:00.000Z",
			"2026-10-29T15:59:59.999Z",
			true,
		],
	])("reuse across the Shanghai day boundary is %s", async (_label, savedAt, now, reused) => {
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
		expect(collectors.collectAccount).toHaveBeenCalledTimes(reused ? 0 : 1);
	});

	it("rejects an adhoc repository missing from the reusable catalogue", async () => {
		const fixture = await setup();
		await withSavedA(fixture, "2026-10-29T02:00:00.000Z");
		const run = await startRefresh(fixture.env, "account", { repo: "octo/missing" });
		await fixture.runner.alarm();
		expect(collectors.collectAccount).not.toHaveBeenCalled();
		expect(collectors.collectRepository).not.toHaveBeenCalled();
		expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
			status: "failed",
			errorCode: "not_found",
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
	"honors the latest upstream deadline for %s rate limits",
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
			expect(fixture.alarmAt()).toBeGreaterThanOrEqual(reset * 1000);
		} finally {
			vi.unstubAllGlobals();
		}
	},
);

it("attributes exhausted repository steps to the repository with safe metadata", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	collectors.collectRepository.mockRejectedValue(
		new ApiError(502, "github_error", "upstream secret detail", null, 502),
	);
	for (let attempt = 0; attempt < 4; attempt++) await deliverNextAlarm(fixture);
	collectors.collectRepository.mockResolvedValue(collected(3, 1, 2));
	await deliverNextAlarm(fixture);
	const stored = await getRefreshRun(fixture.db(), "account", run.id);
	expect(stored).toMatchObject({ status: "partial", completedRepos: 2 });
	expect(stored?.partialReasons).toEqual([
		{
			repo: "octo/one",
			codes: ["github_error"],
			failures: [
				{
					dimension: null,
					code: "github_error",
					httpStatus: 502,
					graphqlType: null,
					graphqlPath: null,
				},
			],
		},
	]);
	expect(
		JSON.stringify((await fixture.raw.prepare("SELECT payload FROM refresh_runs").all()).results),
	).not.toContain("upstream secret detail");
});

it("drains several durable steps per alarm instead of one round trip per repository", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	await fixture.runner.alarm();
	expect(collectors.collectAccount).toHaveBeenCalledOnce();
	expect(collectors.collectRepository.mock.calls.map((call) => call[1])).toEqual([
		"octo/one",
		"octo/two",
	]);
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "completed",
		completedRepos: 2,
	});
	expect(fixture.alarmAt()).toBeNull();
});

it("arms the first step at POST and records honest queued, account and repository timings", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	expect(run.timings?.queuedAt).toBe(run.createdAt);
	expect(run.timings?.a).toBeNull();
	expect(run.timings?.repos).toEqual([]);
	expect(fixture.alarmAt()).not.toBeNull();
	expect(fixture.alarmAt() ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(Date.now());
	await fixture.restart().alarm();
	const timings = (await getRefreshRun(fixture.db(), "account", run.id))?.timings;
	expect(timings?.queuedAt).toBe(run.createdAt);
	expect(timings?.a).toMatchObject({ reused: false, attempts: 1 });
	expect(Date.parse(timings?.a?.startedAt ?? "")).toBeLessThanOrEqual(
		Date.parse(timings?.a?.finishedAt ?? ""),
	);
	expect(timings?.repos.map((step) => step.repo)).toEqual(["octo/one", "octo/two"]);
	for (const step of timings?.repos ?? []) {
		expect(step.finishedAt).not.toBeNull();
		expect(step.attempts).toBe(1);
		expect(Date.parse(step.startedAt)).toBeLessThanOrEqual(Date.parse(step.finishedAt ?? ""));
	}
});

it("never schedules a wakeup beyond the recovery bound during a healthy run", async () => {
	const fixture = await setup();
	collectors.collectAccount.mockResolvedValue({
		repos: ["octo/one", "octo/two", "octo/three"],
		...collected(1, 1, 0),
	});
	const run = await startRefresh(fixture.env, "account", {});
	await fixture.runner.alarm();
	const armed = fixture.storage.setAlarm.mock.calls.map(([at]) => Number(at));
	expect(armed.length).toBeGreaterThan(2);
	for (const at of armed) expect(at).toBeLessThanOrEqual(Date.now() + 5_000);
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "completed",
		completedRepos: 3,
	});
});

it("keeps an interrupted step's recovery wakeup inside five seconds", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	const inFlight = await deferredCollection();
	const step = fixture.runner.alarm();
	const { release } = await inFlight();
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "running",
		phase: "repos",
		timings: {
			a: { attempts: 1 },
			repos: [{ repo: "octo/one", finishedAt: null, attempts: 0 }],
		},
	});
	const armed = fixture.alarmAt() ?? Number.POSITIVE_INFINITY;
	expect(armed).toBeGreaterThan(Date.now());
	expect(armed - Date.now()).toBeLessThanOrEqual(5_000);
	release(collected(3, 1, 2));
	await step;
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "completed",
	});
	expect(fixture.alarmAt()).toBeNull();
});

it("closes an interrupted account attempt when the run is cancelled during backoff", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	collectors.collectAccount.mockRejectedValueOnce(new ApiError(502, "github_error", "safe"));
	await fixture.runner.alarm();
	expect((await getRefreshRun(fixture.db(), "account", run.id))?.timings?.a).toMatchObject({
		attempts: 1,
		finishedAt: null,
	});
	expect((await fixture.cancelRequest(run.id)).status).toBe(202);
	await fixture.runner.alarm();
	const cancelled = await getRefreshRun(fixture.db(), "account", run.id);
	expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "github_error" });
	expect(cancelled?.timings?.a).toMatchObject({ attempts: 1 });
	expect(cancelled?.timings?.a?.finishedAt).toBe(cancelled?.finishedAt);
	expect(cancelled?.timings?.repos).toEqual([]);
});

it("records retried and cancelled steps without inventing finished work", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	collectors.collectRepository.mockRejectedValue(
		new ApiError(503, "github_rate_limited", "safe", new Date(Date.now() + 120_000).toISOString()),
	);
	await fixture.runner.alarm();
	const retrying = await getRefreshRun(fixture.db(), "account", run.id);
	expect(retrying?.timings?.a).toMatchObject({ attempts: 1 });
	expect(retrying?.timings?.a?.finishedAt).not.toBeNull();
	expect(retrying?.timings?.repos).toEqual([
		{ repo: "octo/one", startedAt: expect.any(String), finishedAt: null, attempts: 1 },
	]);
	expect((await fixture.cancelRequest(run.id)).status).toBe(202);
	await fixture.runner.alarm();
	const cancelled = await getRefreshRun(fixture.db(), "account", run.id);
	expect(cancelled).toMatchObject({ status: "cancelled", completedRepos: 0 });
	expect(cancelled?.timings?.repos).toEqual([
		{
			repo: "octo/one",
			startedAt: expect.any(String),
			finishedAt: expect.any(String),
			attempts: 1,
		},
	]);
	expect(cancelled?.timings?.repos[0]?.finishedAt).toBe(cancelled?.finishedAt);
});

it("chains slow A and B in one wake instead of treating I/O wall time as a CPU budget", async () => {
	vi.useFakeTimers({ now: new Date("2026-10-29T04:00:00.000Z"), toFake: ["Date"] });
	try {
		const fixture = await setup();
		collectors.collectAccount.mockImplementation(async () => {
			vi.setSystemTime(Date.now() + 30_000);
			return { repos: ["octo/one", "octo/two"], ...collected(1, 1, 0) };
		});
		collectors.collectRepository.mockImplementation(async () => {
			vi.setSystemTime(Date.now() + 30_000);
			return collected(3, 1, 2);
		});
		const run = await startRefresh(fixture.env, "account", {});
		await fixture.runner.alarm();
		expect(collectors.collectRepository).toHaveBeenCalledTimes(2);
		expect(fixture.alarmAt()).toBeNull();
		expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
			status: "completed",
			completedRepos: 2,
		});
	} finally {
		vi.useRealTimers();
	}
});

it("persists each healthy transition once without re-reading the active run or rearming an immediate alarm", async () => {
	const fixture = await setup();
	collectors.collectAccount.mockResolvedValue({ repos: ["octo/one"], ...collected(2, 2, 0) });
	const run = await startRefresh(fixture.env, "account", { force: true });
	const active = vi.spyOn(refreshStore, "activeRefreshRun");
	const save = vi.spyOn(refreshStore, "saveRefreshRun");
	fixture.storage.setAlarm.mockClear();
	try {
		await fixture.runner.alarm();
		expect(active).toHaveBeenCalledTimes(2);
		expect(save).toHaveBeenCalledTimes(3);
		expect(save.mock.calls[1]?.[1]).toMatchObject({
			phase: "repos",
			timings: { a: { attempts: 1 }, repos: [{ repo: "octo/one", attempts: 0 }] },
		});
		expect(fixture.storage.setAlarm).toHaveBeenCalledTimes(2);
		expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
			status: "completed",
		});
	} finally {
		active.mockRestore();
		save.mockRestore();
	}
});

it("backs off briefly for transient failures and keeps retry-after for rate limits", async () => {
	const fixture = await setup();
	await startRefresh(fixture.env, "account", {});
	collectors.collectAccount.mockRejectedValueOnce(new ApiError(502, "github_error", "safe"));
	await fixture.runner.alarm();
	expect(fixture.alarmAt()).toBeLessThanOrEqual(Date.now() + 10_000);
	const deadline = new Date(Date.now() + 120_000).toISOString();
	collectors.collectAccount.mockRejectedValueOnce(
		new ApiError(503, "github_rate_limited", "safe", deadline),
	);
	await deliverNextAlarm(fixture);
	expect(fixture.alarmAt()).toBeGreaterThanOrEqual(Date.parse(deadline));
});

it.each([false, true])(
	"preserves rate-limit deadlines through an interrupted alarm write (cancel=%s)",
	async (cancel) => {
		vi.useFakeTimers({ now: new Date("2026-10-29T04:00:00.000Z"), toFake: ["Date"] });
		try {
			const fixture = await setup();
			const run = await startRefresh(fixture.env, "account", {});
			const deadline = Date.now() + 120_000;
			collectors.collectAccount.mockImplementationOnce(async () => {
				fixture.storage.setAlarm.mockRejectedValueOnce(new Error("alarm write interrupted"));
				throw new ApiError(
					503,
					"github_rate_limited",
					"safe",
					new Date(deadline).toISOString(),
					429,
				);
			});
			await expect(fixture.runner.alarm()).rejects.toThrow("alarm write interrupted");
			expect(fixture.alarmAt()).toBe(Date.now() + 5_000);
			vi.setSystemTime(Date.now() + 5_000);
			if (cancel) await fixture.cancelRequest(run.id);
			await fixture.restart().alarm();
			expect(collectors.collectAccount).toHaveBeenCalledTimes(1);
			if (cancel) {
				expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
					status: "cancelled",
				});
				expect(fixture.alarmAt()).toBeNull();
			} else {
				expect(fixture.alarmAt()).toBe(deadline);
				vi.setSystemTime(deadline - 1);
				await fixture.restart().alarm();
				expect(collectors.collectAccount).toHaveBeenCalledTimes(1);
				vi.setSystemTime(deadline);
				await fixture.restart().alarm();
				expect(collectors.collectAccount).toHaveBeenCalledTimes(2);
				expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
					status: "completed",
				});
			}
		} finally {
			vi.useRealTimers();
		}
	},
);

it("attributes the pending retry when a run is cancelled during backoff", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	collectors.collectRepository.mockRejectedValue(
		new ApiError(
			503,
			"github_rate_limited",
			"safe",
			new Date(Date.now() + 120_000).toISOString(),
			429,
		),
	);
	await fixture.runner.alarm();
	expect((await fixture.cancelRequest(run.id)).status).toBe(202);
	await fixture.runner.alarm();
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "cancelled",
		errorCode: "github_rate_limited",
		partialReasons: [
			{
				repo: "octo/one",
				codes: ["github_rate_limited"],
				failures: [
					{
						dimension: null,
						code: "github_rate_limited",
						httpStatus: 429,
						graphqlType: null,
						graphqlPath: null,
					},
				],
			},
		],
	});
	expect(fixture.storage.delete).toHaveBeenCalledWith("retry");
});

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
				throw new ApiError(
					503,
					"github_rate_limited",
					"safe",
					new Date(Date.now() + 120_000).toISOString(),
					429,
				);
			}),
		);
		const run = await startRefresh(fixture.env, "account", {});
		for (let attempt = 0; attempt < 3; attempt++) await deliverNextAlarm(fixture);
		const save = refreshStore.saveRefreshRun;
		let interrupted = false;
		const failure = vi
			.spyOn(refreshStore, "saveRefreshRun")
			.mockImplementation(async (db, next) => {
				if (!interrupted && ["failed", "partial"].includes(next.status)) {
					interrupted = true;
					throw new Error("terminal settlement interrupted");
				}
				return save(db, next);
			});
		try {
			await expect(deliverNextAlarm(fixture)).rejects.toThrow("terminal settlement interrupted");
			const failedAt = new Date().toISOString();
			expect(collector).toHaveBeenCalledTimes(4);
			expect(await fixture.storage.get("retry")).toMatchObject({
				attempts: 4,
				notBefore: Date.now() + 120_000,
			});
			expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
				status: "running",
				requests: phase === "account" ? 3 : 4,
			});
			vi.setSystemTime(Date.now() + 5_000);
			if (cancel) await fixture.cancelRequest(run.id);
			await fixture.restart().alarm();
			expect(collector).toHaveBeenCalledTimes(4);
			const finished = await getRefreshRun(fixture.db(), "account", run.id);
			expect(finished).toMatchObject({
				status: cancel ? "cancelled" : phase === "account" ? "failed" : "partial",
				requests: phase === "account" ? 4 : 5,
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
			expect(await fixture.storage.get("retry")).toBeUndefined();
			expect(fixture.alarmAt()).toBeNull();
		} finally {
			failure.mockRestore();
		}
	},
);

it.each(["committed-save", "retry-delete"])(
	"fences an exhausted repository marker after %s acknowledgement fails",
	async (boundary) => {
		const fixture = await setup();
		collectors.collectRepository.mockImplementation(async (context, repo) => {
			if (repo === "octo/two") return collected(3, 1, 2);
			context.onRequests(1, { graphql: 1, rest: 0 });
			throw new ApiError(
				503,
				"github_rate_limited",
				"safe",
				new Date(Date.now() + 120_000).toISOString(),
			);
		});
		const run = await startRefresh(fixture.env, "account", {});
		for (let attempt = 0; attempt < 3; attempt++) await deliverNextAlarm(fixture);
		const save = refreshStore.saveRefreshRun;
		let interrupted = false;
		const failure = vi
			.spyOn(refreshStore, "saveRefreshRun")
			.mockImplementation(async (db, next) => {
				await save(db, next);
				if (!interrupted && next.completedRepos === 1) {
					interrupted = true;
					if (boundary === "committed-save") throw new Error("settlement acknowledgement lost");
					fixture.storage.delete.mockRejectedValueOnce(
						new Error("settlement acknowledgement lost"),
					);
				}
			});
		try {
			await expect(deliverNextAlarm(fixture)).rejects.toThrow("settlement acknowledgement lost");
			expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
				status: "running",
				completedRepos: 1,
				requests: 5,
			});
			await deliverNextAlarm(fixture);
			expect(collectors.collectRepository.mock.calls.map(([, repo]) => repo)).toEqual([
				"octo/one",
				"octo/one",
				"octo/one",
				"octo/one",
				"octo/two",
			]);
			expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
				status: "partial",
				completedRepos: 2,
				requests: 8,
			});
			expect(await fixture.storage.get("retry")).toBeUndefined();
		} finally {
			failure.mockRestore();
		}
	},
);

it.each([false, true])(
	"retains retry until successful D1 settlement (cancel=%s)",
	async (cancel) => {
		const fixture = await setup();
		collectors.collectAccount
			.mockRejectedValueOnce(new ApiError(502, "github_error", "safe"))
			.mockResolvedValue({ repos: [], ...collected(1, 1, 0) });
		const run = await startRefresh(fixture.env, "account", {});
		await fixture.runner.alarm();
		if (cancel) await fixture.cancelRequest(run.id);
		const save = refreshStore.saveRefreshRun;
		let interrupted = false;
		const failure = vi
			.spyOn(refreshStore, "saveRefreshRun")
			.mockImplementation(async (db, next) => {
				if (!interrupted && ["completed", "cancelled"].includes(next.status)) {
					interrupted = true;
					throw new Error("D1 unavailable");
				}
				return save(db, next);
			});
		try {
			await expect(deliverNextAlarm(fixture)).rejects.toThrow("D1 unavailable");
			expect(await fixture.storage.get("retry")).toMatchObject({ attempts: 1 });
			if (cancel) expect(await fixture.storage.get(`cancel:${run.id}`)).toBe(true);
			await deliverNextAlarm(fixture);
			expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
				status: cancel ? "cancelled" : "completed",
			});
			expect(await fixture.storage.get("retry")).toBeUndefined();
			expect(await fixture.storage.get(`cancel:${run.id}`)).toBeUndefined();
		} finally {
			failure.mockRestore();
		}
	},
);

it.each(["committed-save", "retry-delete"])(
	"does not reopen a terminal run or apply its marker to a new run after %s fails",
	async (boundary) => {
		const fixture = await setup();
		collectors.collectAccount.mockImplementation(async (context) => {
			context.onRequests(1, { graphql: 1, rest: 0 });
			throw new ApiError(
				503,
				"github_rate_limited",
				"safe",
				new Date(Date.now() + 120_000).toISOString(),
			);
		});
		const run = await startRefresh(fixture.env, "account", {});
		for (let attempt = 0; attempt < 3; attempt++) await deliverNextAlarm(fixture);
		const save = refreshStore.saveRefreshRun;
		let interrupted = false;
		const failure = vi
			.spyOn(refreshStore, "saveRefreshRun")
			.mockImplementation(async (db, next) => {
				await save(db, next);
				if (!interrupted && next.status === "failed") {
					interrupted = true;
					if (boundary === "committed-save") throw new Error("terminal acknowledgement lost");
					fixture.storage.delete.mockRejectedValueOnce(new Error("terminal acknowledgement lost"));
				}
			});
		try {
			await expect(deliverNextAlarm(fixture)).rejects.toThrow("terminal acknowledgement lost");
			const terminal = await getRefreshRun(fixture.db(), "account", run.id);
			expect(terminal).toMatchObject({ status: "failed", requests: 4 });
			if (boundary === "retry-delete") {
				await deliverNextAlarm(fixture);
				expect(collectors.collectAccount).toHaveBeenCalledTimes(4);
				expect(await fixture.storage.get("retry")).toBeUndefined();
			}
			collectors.collectAccount.mockResolvedValue({ repos: [], ...collected(1, 1, 0) });
			const next = await startRefresh(fixture.env, "account", {});
			await deliverNextAlarm(fixture);
			expect(await getRefreshRun(fixture.db(), "account", run.id)).toEqual(terminal);
			expect(await getRefreshRun(fixture.db(), "account", next.id)).toMatchObject({
				status: "completed",
				requests: 1,
				errorCode: null,
			});
			expect(collectors.collectAccount).toHaveBeenCalledTimes(5);
		} finally {
			failure.mockRestore();
		}
	},
);

it.each([false, true])(
	"rearms recovery for repeated exhausted settlement failures (cancel=%s)",
	async (cancel) => {
		const fixture = await setup();
		collectors.collectAccount.mockRejectedValue(new ApiError(503, "github_rate_limited", "safe"));
		const run = await startRefresh(fixture.env, "account", {});
		for (let attempt = 0; attempt < 3; attempt++) await deliverNextAlarm(fixture);
		const save = refreshStore.saveRefreshRun;
		let failures = 3;
		const failure = vi
			.spyOn(refreshStore, "saveRefreshRun")
			.mockImplementation(async (db, next) => {
				if (["failed", "cancelled"].includes(next.status) && failures > 0) {
					failures -= 1;
					throw new Error("settlement still unavailable");
				}
				return save(db, next);
			});
		try {
			await expect(deliverNextAlarm(fixture)).rejects.toThrow("settlement still unavailable");
			if (cancel) await fixture.cancelRequest(run.id);
			for (let replay = 0; replay < 2; replay++) {
				await expect(deliverNextAlarm(fixture)).rejects.toThrow("settlement still unavailable");
				expect(fixture.alarmAt()).toBe(Date.now() + 5_000);
				expect(collectors.collectAccount).toHaveBeenCalledTimes(4);
				expect(await fixture.storage.get("retry")).toMatchObject({ attempts: 4 });
			}
			await deliverNextAlarm(fixture);
			expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
				status: cancel ? "cancelled" : "failed",
			});
			expect(collectors.collectAccount).toHaveBeenCalledTimes(4);
			expect(fixture.alarmAt()).toBeNull();
		} finally {
			failure.mockRestore();
		}
	},
);

it("clears a resolved transient failure code before the run finishes", async () => {
	const fixture = await setup();
	collectors.collectAccount.mockResolvedValue({ repos: ["octo/one"], ...collected(1, 1, 0) });
	collectors.collectRepository
		.mockRejectedValueOnce(new ApiError(502, "github_error", "safe"))
		.mockResolvedValue(collected(3, 1, 2));
	const run = await startRefresh(fixture.env, "account", {});
	await fixture.runner.alarm();
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		errorCode: "github_error",
		status: "running",
	});
	await deliverNextAlarm(fixture);
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "completed",
		errorCode: null,
		partial: false,
		partialReasons: [],
	});
});

it.each([1, 2])(
	"attributes exhausted cancellation only to the failed repo among %i repos",
	async (count) => {
		const fixture = await setup();
		const repos = ["octo/one", "octo/two"].slice(0, count);
		collectors.collectAccount.mockResolvedValue({ repos, ...collected(1, 1, 0) });
		const run = await startRefresh(fixture.env, "account", {});
		collectors.collectRepository.mockRejectedValue(new ApiError(502, "github_error", "safe"));
		for (let attempt = 0; attempt < 3; attempt++) await deliverNextAlarm(fixture);
		collectors.collectRepository.mockImplementationOnce(async () => {
			await fixture.cancelRequest(run.id);
			throw new ApiError(502, "github_error", "safe");
		});
		await deliverNextAlarm(fixture);
		const saved = await getRefreshRun(fixture.db(), "account", run.id);
		expect(saved).toMatchObject({ status: "cancelled", completedRepos: 1 });
		expect(saved?.partialReasons.map((reason) => reason.repo)).toEqual(["octo/one"]);
	},
);

it("drains a large healthy run without exhausting a shared D1 statement budget", async () => {
	const fixture = await setup();
	const repos = Array.from({ length: 35 }, (_, index) => `octo/repo-${index}`);
	collectors.collectAccount.mockResolvedValue({ repos, ...collected(0, 0, 0) });
	collectors.collectRepository.mockResolvedValue(collected(0, 0, 0));
	const run = await startRefresh(fixture.env, "account", {});
	await fixture.runner.alarm();
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "running",
		completedRepos: 29,
	});
	expect(fixture.alarmAt()).not.toBeNull();
	await fixture.restart().alarm();
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "completed",
		completedRepos: 35,
	});
	expect(collectors.collectRepository.mock.calls.map((call) => call[1])).toEqual(repos);
	expect(fixture.alarmAt()).toBeNull();
});
