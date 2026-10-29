import { beforeEach, expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../tests/fixtures/sqlite";
import type { Env } from "./env";
import { createDb } from "./lib/db/d1";
import { ApiError } from "./lib/errors";
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
	await fixture.runner.alarm();
	expect(collectors.collectAccount).toHaveBeenCalledOnce();
	expect(collectors.collectRepository).not.toHaveBeenCalled();
	await fixture.restart().alarm();
	expect(collectors.collectRepository.mock.calls[0]?.[1]).toBe("octo/one");
	await fixture.runner.alarm();
	expect(collectors.collectRepository.mock.calls[1]?.[1]).toBe("octo/two");
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
	await fixture.runner.alarm();
	collectors.collectRepository.mockRejectedValue(
		new ApiError(503, "github_rate_limited", "safe", new Date(Date.now() + 120_000).toISOString()),
	);
	for (let attempt = 0; attempt < 4; attempt++) await fixture.restart().alarm();
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		completedRepos: 1,
		partial: true,
		partialReasons: [{ repo: "octo/one", codes: ["github_rate_limited"] }],
	});
	collectors.collectRepository.mockResolvedValue(collected(2, 0, 2));
	await fixture.restart().alarm();
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
	await fixture.runner.alarm();
	collectors.collectRepository.mockRejectedValueOnce(
		new ApiError(502, "github_error", "safe", "invalid"),
	);
	await fixture.runner.alarm();
	collectors.collectRepository.mockRejectedValue(new Error(fixture.token));
	for (let attempt = 0; attempt < 3; attempt++) await fixture.restart().alarm();
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
	await fixture.runner.alarm();
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
	await fixture.runner.alarm();
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
	await fixture.runner.alarm();
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
	await fixture.runner.alarm();
	const accepted = await fixture.cancelRequest(run.id);
	expect(accepted.status).toBe(202);
	expect((await accepted.json()) as { cancelRequested: boolean }).toMatchObject({
		cancelRequested: true,
	});
	await fixture.runner.alarm();
	const first = await fixture.cancelRequest(run.id);
	expect(first.status).toBe(200);
	const terminal = (await first.json()) as { status: string; completedRepos: number };
	expect(terminal).toMatchObject({ status: "cancelled", completedRepos: 0 });
	expect(await (await fixture.cancelRequest(run.id)).json()).toEqual(terminal);
	const completed = await startRefresh(fixture.env, "account", {});
	await fixture.runner.alarm();
	await fixture.runner.alarm();
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
	await fixture.runner.alarm();
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
	await fixture.runner.alarm();
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
	await fixture.runner.alarm();
	const scheduled = await startRefresh(fixture.env, "account", {}, "scheduled");
	const inFlight = await deferredCollection();
	const step = fixture.runner.alarm();
	const { release } = await inFlight();
	const safetyAlarm = fixture.alarmAt();
	expect((await fixture.cancelRequest(scheduled.id)).status).toBe(200);
	expect(fixture.alarmAt()).toBe(safetyAlarm);
	release(collected(3, 1, 2));
	await step;
	expect(await getRefreshRun(fixture.db(), "account", scheduled.id)).toMatchObject({
		status: "cancelled",
	});
	expect(await getRefreshRun(fixture.db(), "account", running.id)).toMatchObject({
		completedRepos: 1,
	});
	await fixture.runner.alarm();
	await fixture.runner.alarm();
	expect((await getRefreshRun(fixture.db(), "account", running.id))?.status).toBe("completed");
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
