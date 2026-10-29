import { beforeEach, expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../tests/fixtures/sqlite";
import type { Env } from "./env";
import { createDb } from "./lib/db/d1";
import { ApiError } from "./lib/errors";
import { getRefreshRun, saveRefreshRun } from "./lib/refresh-store";
import { encryptToken, parseKeyBytes } from "./lib/token-crypto";
import { RefreshRunner, scheduleRefresh, startRefresh } from "./refresh-runner";

const collectors = vi.hoisted(() => ({ collectAccount: vi.fn(), collectRepository: vi.fn() }));
vi.mock("./lib/refresh-collection", () => collectors);
beforeEach(() => {
	collectors.collectAccount
		.mockReset()
		.mockResolvedValue({ repos: ["octo/one", "octo/two"], requests: 1, partial: false });
	collectors.collectRepository.mockReset().mockResolvedValue({ requests: 3, partial: false });
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
	const storage = {
		get: vi.fn(async (key: string) => values.get(key)),
		put: vi.fn(async (key: string, value: unknown) => {
			values.set(key, value);
		}),
		delete: vi.fn(async (key: string) => values.delete(key)),
		setAlarm: vi.fn(async (_at: number) => {}),
		deleteAlarm: vi.fn(async () => {}),
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
	return {
		raw,
		env,
		token,
		storage,
		runner,
		isLocked: () => locked,
		restart() {
			runner = new RefreshRunner(state, env);
			return runner;
		},
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
	expect(await getRefreshRun(createDb(fixture.raw), "account", run.id)).toMatchObject({
		status: "completed",
		phase: "done",
		completedRepos: 2,
		requests: 7,
	});
	expect(
		JSON.stringify((await fixture.raw.prepare("SELECT payload FROM refresh_runs").all()).results),
	).not.toContain(fixture.token);
	expect(fixture.storage.deleteAlarm).toHaveBeenCalled();
});
it("does not execute B after account failure or persist raw failure details", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	collectors.collectAccount.mockRejectedValue(
		new ApiError(401, "github_unauthorized", fixture.token),
	);
	await fixture.runner.alarm();
	expect(collectors.collectRepository).not.toHaveBeenCalled();
	expect(await getRefreshRun(createDb(fixture.raw), "account", run.id)).toMatchObject({
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
	expect(await getRefreshRun(createDb(fixture.raw), "account", run.id)).toMatchObject({
		completedRepos: 1,
		partial: true,
	});
	collectors.collectRepository.mockResolvedValue({ requests: 2, partial: false });
	await fixture.restart().alarm();
	expect(await getRefreshRun(createDb(fixture.raw), "account", run.id)).toMatchObject({
		status: "partial",
		completedRepos: 2,
	});
});
it("deduplicates scheduled deliveries after completion and idles without an account", async () => {
	const fixture = await setup();
	await fixture.runner.alarm();
	collectors.collectAccount.mockResolvedValue({ repos: [], requests: 1, partial: false });
	const at = new Date("2026-10-28T19:00:00.000Z");
	const run = await startRefresh(fixture.env, "account", {}, "scheduled", at);
	await fixture.runner.alarm();
	expect((await startRefresh(fixture.env, "account", {}, "scheduled", at)).id).toBe(run.id);
	expect(await getRefreshRun(createDb(fixture.raw), "account", run.id)).toMatchObject({
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
	collectors.collectAccount.mockResolvedValue({ repos: [], requests: 1, partial: false });
	const adhoc = await startRefresh(fixture.env, "account", { repo: "octo/one" });
	await expect(startRefresh(fixture.env, "account", { repo: "octo/two" })).rejects.toMatchObject({
		code: "refresh_conflict",
	});
	const scheduled = await startRefresh(fixture.env, "account", {}, "scheduled");
	expect(scheduled.id).not.toBe(adhoc.id);
	await fixture.runner.alarm();
	expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();
	await fixture.runner.alarm();
	expect(await getRefreshRun(createDb(fixture.raw), "account", scheduled.id)).toMatchObject({
		status: "completed",
	});
	expect(await getRefreshRun(createDb(fixture.raw), "account", adhoc.id)).toMatchObject({
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
					new Request("https://refresh.internal", { method: "POST", body }),
				)
			).status,
		).toBeGreaterThanOrEqual(400);
	}
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
	expect(await getRefreshRun(createDb(fixture.raw), "account", run.id)).toMatchObject({
		status: "failed",
		errorCode: "encryption_misconfigured",
	});
	Object.assign(fixture.env, { TOKEN_ENCRYPTION_KEY_V1: "0".repeat(64) });
	const next = await startRefresh(fixture.env, "account", {});
	await saveRefreshRun(createDb(fixture.raw), { ...next, phase: "repos" });
	await fixture.runner.alarm();
	expect(await getRefreshRun(createDb(fixture.raw), "account", next.id)).toMatchObject({
		status: "failed",
		errorCode: "validation_failed",
	});
});
it("bounds unknown repository failures, rejects invalid retry timestamps and publishes partial completion", async () => {
	const fixture = await setup();
	collectors.collectAccount.mockResolvedValue({ repos: ["octo/one"], requests: 1, partial: true });
	const run = await startRefresh(fixture.env, "account", {});
	await fixture.runner.alarm();
	collectors.collectRepository.mockRejectedValueOnce(
		new ApiError(502, "github_error", "safe", "invalid"),
	);
	await fixture.runner.alarm();
	collectors.collectRepository.mockRejectedValue(new Error(fixture.token));
	for (let attempt = 0; attempt < 3; attempt++) await fixture.restart().alarm();
	expect(await getRefreshRun(createDb(fixture.raw), "account", run.id)).toMatchObject({
		status: "partial",
		errorCode: "refresh_failed",
		completedRepos: 1,
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
	collectors.collectAccount.mockResolvedValue({ repos: [], requests: 1, partial: false });
	await fixture.runner.alarm();
	expect(await getRefreshRun(createDb(fixture.raw), "account", run.id)).toMatchObject({
		status: "completed",
		errorCode: null,
	});
});

it("counts failed upstream attempts without treating durable steps as requests", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	collectors.collectAccount.mockImplementationOnce(async (context) => {
		context.onRequests(2);
		throw new ApiError(502, "github_error", "safe");
	});
	await fixture.runner.alarm();
	expect(await getRefreshRun(createDb(fixture.raw), "account", run.id)).toMatchObject({
		requests: 2,
	});
	collectors.collectAccount.mockResolvedValue({ repos: [], requests: 1, partial: false });
	await fixture.runner.alarm();
	expect(await getRefreshRun(createDb(fixture.raw), "account", run.id)).toMatchObject({
		requests: 3,
		status: "completed",
	});
});

it("does not retry an adhoc repository absent from the refreshed catalogue", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", { repo: "octo/missing" });
	collectors.collectAccount.mockImplementationOnce(async (context) => {
		context.onRequests(1);
		throw new ApiError(404, "not_found", "repository missing");
	});
	await fixture.runner.alarm();
	expect(await getRefreshRun(createDb(fixture.raw), "account", run.id)).toMatchObject({
		status: "failed",
		errorCode: "not_found",
		requests: 1,
	});
	expect(fixture.storage.put).not.toHaveBeenCalledWith("retry", expect.anything());
	expect(collectors.collectRepository).not.toHaveBeenCalled();
});

it("serializes idle cleanup with incoming starts so new queued work retains its alarm", async () => {
	const fixture = await setup();
	collectors.collectAccount.mockResolvedValue({ repos: [], requests: 1, partial: false });
	await startRefresh(fixture.env, "account", {});
	let incoming: ReturnType<typeof startRefresh> | undefined;
	let alarmAt: number | null = null;
	fixture.storage.setAlarm.mockImplementation(async (at) => {
		alarmAt = at;
	});
	fixture.storage.deleteAlarm.mockImplementationOnce(async () => {
		expect(fixture.isLocked()).toBe(true);
		incoming = startRefresh(fixture.env, "account", { force: true });
		await new Promise<void>((resolve) => setImmediate(resolve));
		alarmAt = null;
	});
	await fixture.runner.alarm();
	const queued = await incoming;
	expect(queued?.status).toBe("queued");
	expect(alarmAt).not.toBeNull();
	await fixture.runner.alarm();
	expect(await getRefreshRun(createDb(fixture.raw), "account", queued?.id ?? "")).toMatchObject({
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
