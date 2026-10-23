import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { dispatchRunState, dueRuns, expireRuns } from "./db/factory-runs";
import { consumeFactory, continueFactory, enqueueRun } from "./factory-dispatch";
import { executeRunPage } from "./factory-execute";
import { pruneFactory } from "./factory-retention";
import { scheduleRefreshes } from "./refresh-schedule";

const { logFactory } = vi.hoisted(() => ({ logFactory: vi.fn() }));
vi.mock("./factory-log", () => ({ logFactory }));
vi.mock("./refresh-schedule", () => ({ scheduleRefreshes: vi.fn() }));
vi.mock("./factory-retention", () => ({ pruneFactory: vi.fn() }));
vi.mock("./factory-execute", () => ({ executeRunPage: vi.fn() }));
vi.mock("./db/factory-runs", () => ({
	dueRuns: vi.fn(),
	expireRuns: vi.fn(),
	dispatchRunState: vi.fn(),
}));
const hour = Date.parse("2026-10-03T11:00:00Z");
beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(hour);
	vi.mocked(dueRuns).mockResolvedValue([]);
	vi.mocked(pruneFactory).mockResolvedValue(undefined);
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.resetAllMocks();
});

it("backs off overloaded sends by 0.5, 1 and 2 seconds without moving the target deadline", async () => {
	const error = new Error("Queue is overloaded. Please back off. (10250)");
	const send = vi
		.fn()
		.mockRejectedValueOnce(error)
		.mockRejectedValueOnce(error)
		.mockRejectedValueOnce(error)
		.mockResolvedValue(undefined);
	const env = { FACTORY_QUEUE: { send } } as unknown as Env;
	const pending = enqueueRun(env, "overloaded", new Date(hour + 10000).toISOString());
	const result = pending.catch((error: unknown) => error);
	let attempt = 1;
	for (const retryDelayMs of [500, 1000, 2000]) {
		await vi.advanceTimersByTimeAsync(retryDelayMs - 1);
		expect(send).toHaveBeenCalledTimes(attempt);
		expect(logFactory).toHaveBeenNthCalledWith(
			attempt,
			"factory_queue_send_error",
			{ runId: "overloaded", attempt, retryDelayMs },
			error,
		);
		await vi.advanceTimersByTimeAsync(1);
		attempt++;
		expect(send).toHaveBeenCalledTimes(attempt);
	}
	expect(await result).toBeUndefined();
	expect(send.mock.calls).toEqual(
		[10, 10, 9, 7].map((delaySeconds) => [{ id: "overloaded" }, { delaySeconds }]),
	);
	expect(logFactory).toHaveBeenCalledTimes(3);
	expect(vi.getTimerCount()).toBe(0);
});

it.each([
	new Error("Queue is overloaded. Please back off. (10250)"),
	new Error("Queue send failed with status 429"),
	"Queue send failed (429)",
	{ message: "Queue is overloaded (10250)" },
	{ code: 10250 },
	{ code: "10250" },
	{ code: 429 },
	{ code: "429" },
	{ status: 429 },
	{ status: "429" },
	{ statusCode: 429 },
	{ statusCode: "429" },
])("bounds overload retries and preserves the final failure: %j", async (error) => {
	const send = vi.fn().mockRejectedValue(error);
	const env = { FACTORY_QUEUE: { send } } as unknown as Env;
	const result = expect(enqueueRun(env, "overloaded")).rejects.toBe(error);
	await vi.runAllTimersAsync();
	await result;
	expect(send).toHaveBeenCalledTimes(4);
	expect(Date.now() - hour).toBe(3500);
	expect(logFactory).toHaveBeenCalledTimes(4);
	expect(logFactory).toHaveBeenLastCalledWith(
		"factory_queue_send_error",
		{ runId: "overloaded", attempt: 4, retryDelayMs: null },
		error,
	);
	expect(vi.getTimerCount()).toBe(0);
});

it.each([
	new Error("queue unavailable"),
	new Error("queue failure 1429 / 102500"),
	{ status: 503 },
	{ code: "1429", statusCode: 500 },
	{ message: 429 },
	null,
	undefined,
	false,
	429,
])("logs non-overload send failures without retrying: %j", async (error) => {
	const send = vi.fn().mockRejectedValue(error);
	const env = { FACTORY_QUEUE: { send } } as unknown as Env;
	await expect(enqueueRun(env, "failed")).rejects.toBe(error);
	expect(send).toHaveBeenCalledOnce();
	expect(logFactory).toHaveBeenCalledExactlyOnceWith(
		"factory_queue_send_error",
		{ runId: "failed", attempt: 1, retryDelayMs: null },
		error,
	);
	expect(vi.getTimerCount()).toBe(0);
});

it("stops retrying immediately when overload becomes a permanent failure", async () => {
	const error = new Error("queue unavailable");
	const send = vi.fn().mockRejectedValueOnce({ status: 429 }).mockRejectedValue(error);
	const env = { FACTORY_QUEUE: { send } } as unknown as Env;
	const result = enqueueRun(env, "failed").catch((failure: unknown) => failure);
	await vi.runAllTimersAsync();
	expect(await result).toBe(error);
	expect(send).toHaveBeenCalledTimes(2);
	expect(Date.now() - hour).toBe(500);
	expect(logFactory).toHaveBeenLastCalledWith(
		"factory_queue_send_error",
		{ runId: "failed", attempt: 2, retryDelayMs: null },
		error,
	);
});

it("never forwards arbitrary queue payloads into structured log fields", async () => {
	const error = { status: 500, payload: "private upstream body", token: "test-only-token" };
	const env = { FACTORY_QUEUE: { send: vi.fn().mockRejectedValue(error) } } as unknown as Env;
	await expect(enqueueRun(env, "safe-run")).rejects.toBe(error);
	expect(logFactory).toHaveBeenCalledExactlyOnceWith(
		"factory_queue_send_error",
		{ runId: "safe-run", attempt: 1, retryDelayMs: null },
		error,
	);
});

it("keeps every minute dispatch but prunes only hourly scheduled occurrences", async () => {
	const send = vi.fn();
	const env = { FACTORY_QUEUE: { send } } as unknown as Env;
	vi.mocked(dueRuns).mockResolvedValue(["due"]);
	for (let minute = 0; minute < 60; minute++) await continueFactory(env, hour + minute * 60000);
	expect(scheduleRefreshes).toHaveBeenCalledTimes(60);
	expect(dueRuns).toHaveBeenCalledTimes(60);
	expect(send).toHaveBeenCalledTimes(60);
	expect(pruneFactory).toHaveBeenCalledTimes(1);
	await continueFactory(env, hour + 3600000);
	expect(scheduleRefreshes).toHaveBeenCalledTimes(61);
	expect(dueRuns).toHaveBeenCalledTimes(61);
	expect(send).toHaveBeenCalledTimes(61);
	expect(pruneFactory).toHaveBeenCalledTimes(2);
});

it.each(["completed", "failed", "running", "paused"])(
	"hands off only terminal runs after delivery: %s",
	async (status) => {
		const send = vi.fn();
		const env = { FACTORY_QUEUE: { send } } as unknown as Env;
		vi.mocked(executeRunPage).mockResolvedValueOnce(null);
		vi.mocked(dispatchRunState).mockResolvedValueOnce({ account_id: "account", status });
		vi.mocked(dueRuns).mockResolvedValueOnce(["successor"]);
		vi.mocked(scheduleRefreshes).mockImplementationOnce(async (_db, _now, _account, clock) => {
			expect(clock?.()).toBe(new Date(hour).toISOString());
		});
		const message = { body: { id: "finished" }, attempts: 1, ack: vi.fn(), retry: vi.fn() };
		await consumeFactory({ messages: [message] } as unknown as MessageBatch<unknown>, env);
		if (["running", "paused"].includes(status)) {
			expect(scheduleRefreshes).not.toHaveBeenCalled();
			expect(send).not.toHaveBeenCalled();
		} else {
			expect(scheduleRefreshes).toHaveBeenCalledExactlyOnceWith(
				env.DB,
				new Date(hour).toISOString(),
				"account",
				expect.any(Function),
			);
			expect(dueRuns).toHaveBeenCalledExactlyOnceWith(
				expect.anything(),
				new Date(hour).toISOString(),
				"account",
			);
			expect(send).toHaveBeenCalledExactlyOnceWith({ id: "successor" }, { delaySeconds: 0 });
		}
		expect(message.ack).toHaveBeenCalledOnce();
		expect(message.retry).not.toHaveBeenCalled();
		expect(logFactory).not.toHaveBeenCalled();
	},
);

it("uses the event UTC minute for eligibility and wallclock for schedule and cleanup cutoffs", async () => {
	const env = { FACTORY_QUEUE: { send: vi.fn() } } as unknown as Env;
	vi.setSystemTime("2026-10-03T11:03:00Z");
	vi.mocked(scheduleRefreshes).mockImplementationOnce(async (_db, _now, _account, clock) => {
		expect(clock?.()).toBe("2026-10-03T11:03:00.000Z");
	});
	await continueFactory(env, hour);
	expect(pruneFactory).toHaveBeenLastCalledWith(expect.anything(), "2026-10-03T11:03:00.000Z");
	expect(scheduleRefreshes).toHaveBeenLastCalledWith(
		env.DB,
		"2026-10-03T11:03:00.000Z",
		"",
		expect.any(Function),
	);
	expect(dueRuns).toHaveBeenLastCalledWith(expect.anything(), "2026-10-03T11:03:00.000Z");
	vi.setSystemTime("2026-10-03T12:00:00Z");
	await continueFactory(env, hour + 59 * 60000);
	expect(pruneFactory).toHaveBeenCalledTimes(1);
	expect(scheduleRefreshes).toHaveBeenLastCalledWith(
		env.DB,
		"2026-10-03T12:00:00.000Z",
		"",
		expect.any(Function),
	);
	expect(dueRuns).toHaveBeenLastCalledWith(expect.anything(), "2026-10-03T12:00:00.000Z");
});

it.each([0, 1])("runs cleanup after queue failure only at scheduled minute %i", async (minute) => {
	const env = {
		FACTORY_QUEUE: { send: vi.fn().mockRejectedValue(new Error("queue unavailable")) },
	} as unknown as Env;
	vi.mocked(dueRuns).mockResolvedValue(["due"]);
	await expect(continueFactory(env, hour + minute * 60000)).rejects.toThrow("queue unavailable");
	expect(pruneFactory).toHaveBeenCalledTimes(minute === 0 ? 1 : 0);
});

it.each([0, 1])(
	"runs cleanup after schedule failure only at scheduled minute %i",
	async (minute) => {
		vi.mocked(scheduleRefreshes).mockRejectedValueOnce(new Error("schedule unavailable"));
		const env = { FACTORY_QUEUE: { send: vi.fn() } } as unknown as Env;
		await expect(continueFactory(env, hour + minute * 60000)).rejects.toThrow(
			"schedule unavailable",
		);
		expect(dueRuns).not.toHaveBeenCalled();
		expect(env.FACTORY_QUEUE.send).not.toHaveBeenCalled();
		expect(pruneFactory).toHaveBeenCalledTimes(minute === 0 ? 1 : 0);
	},
);

it.each([0, 1])(
	"runs cleanup after due-run failure only at scheduled minute %i",
	async (minute) => {
		vi.mocked(dueRuns).mockRejectedValueOnce(new Error("due runs unavailable"));
		const env = { FACTORY_QUEUE: { send: vi.fn() } } as unknown as Env;
		await expect(continueFactory(env, hour + minute * 60000)).rejects.toThrow(
			"due runs unavailable",
		);
		expect(env.FACTORY_QUEUE.send).not.toHaveBeenCalled();
		expect(pruneFactory).toHaveBeenCalledTimes(minute === 0 ? 1 : 0);
	},
);
it("acknowledges duplicates, retries failures and schedules durable continuation with bounded delays", async () => {
	const send = vi.fn();
	const env = { FACTORY_QUEUE: { send } } as unknown as Env;
	const ack = vi.fn(),
		retry = vi.fn();
	const messages = [null, { id: "../bad" }, { id: "ok" }, { id: "again" }, { id: "error" }].map(
		(body) => ({ body, ack, retry }),
	);
	vi.mocked(executeRunPage)
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce(new Date(Date.now() + 60000).toISOString())
		.mockRejectedValueOnce(new Error("db unavailable"));
	await consumeFactory({ messages } as unknown as MessageBatch<unknown>, env);
	expect(ack).toHaveBeenCalledTimes(4);
	expect(retry).toHaveBeenCalledWith({ delaySeconds: 5 });
	expect(send).toHaveBeenCalledWith({ id: "again" }, { delaySeconds: 60 });
	await enqueueRun(env, "now");
	expect(send).toHaveBeenLastCalledWith({ id: "now" }, { delaySeconds: 0 });
	await enqueueRun(env, "later", "2999-01-01T00:00:00Z");
	expect(send).toHaveBeenLastCalledWith({ id: "later" }, { delaySeconds: 43200 });
	vi.mocked(dueRuns).mockResolvedValue(["orphan"]);
	await continueFactory(env, hour);
	expect(send).toHaveBeenLastCalledWith({ id: "orphan" }, { delaySeconds: 0 });
});

it("acknowledges retired review messages without inference, retries or rescheduling", async () => {
	const send = vi.fn();
	const env = { FACTORY_QUEUE: { send } } as unknown as Env;
	const ack = vi.fn(),
		retry = vi.fn();
	await consumeFactory(
		{
			messages: [
				{ body: { reviewId: "ai_job" }, ack, retry },
				{ body: {}, ack, retry },
			],
		} as unknown as MessageBatch<unknown>,
		env,
	);
	expect(ack).toHaveBeenCalledTimes(2);
	expect(retry).not.toHaveBeenCalled();
	expect(send).not.toHaveBeenCalled();
	expect(executeRunPage).not.toHaveBeenCalled();
	vi.mocked(dueRuns).mockResolvedValue([]);
	await continueFactory(env, hour);
	expect(send).not.toHaveBeenCalled();
});

it("expires deadlines before scheduling and delegates queue expiry to the executor", async () => {
	const env = { FACTORY_QUEUE: { send: vi.fn() } } as unknown as Env;
	await continueFactory(env, hour);
	expect(expireRuns).toHaveBeenCalledWith(expect.anything(), "2026-10-03T11:00:00.000Z");
	expect(vi.mocked(expireRuns).mock.invocationCallOrder[0]).toBeLessThan(
		vi.mocked(scheduleRefreshes).mock.invocationCallOrder[0] ?? 0,
	);
	vi.mocked(executeRunPage).mockResolvedValue(null);
	const message = { body: { id: "expired" }, ack: vi.fn(), retry: vi.fn() };
	await consumeFactory({ messages: [message] } as unknown as MessageBatch<unknown>, env);
	expect(expireRuns).toHaveBeenCalledOnce();
	expect(executeRunPage).toHaveBeenCalledExactlyOnceWith(env, "expired");
	expect(message.ack).toHaveBeenCalledOnce();
	expect(message.retry).not.toHaveBeenCalled();
});

it.each([
	[undefined, 5],
	[0, 5],
	[1, 5],
	[2, 10],
	[3, 15],
	[4, 15],
	[1000, 15],
])(
	"retries message attempt %s after %s seconds and logs safe context",
	async (attempts, delaySeconds) => {
		const error = new Error("db unavailable");
		vi.mocked(executeRunPage).mockRejectedValueOnce(error);
		const env = { FACTORY_QUEUE: { send: vi.fn() } } as unknown as Env;
		const message = {
			body: { id: "retry-run", token: "test-only-token" },
			attempts,
			ack: vi.fn(),
			retry: vi.fn(),
		};
		await consumeFactory({ messages: [message] } as unknown as MessageBatch<unknown>, env);
		expect(message.ack).not.toHaveBeenCalled();
		expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds });
		expect(logFactory).toHaveBeenCalledExactlyOnceWith(
			"factory_consume_error",
			{ runId: "retry-run", attempt: attempts ?? 1, retryDelaySeconds: delaySeconds },
			error,
		);
		expect(env.FACTORY_QUEUE.send).not.toHaveBeenCalled();
	},
);

it("retries the delivery after exhausted continuation sends and keeps processing the batch", async () => {
	const error = new Error("Queue is overloaded. Please back off. (10250)");
	const send = vi.fn().mockRejectedValue(error);
	const env = { FACTORY_QUEUE: { send } } as unknown as Env;
	vi.mocked(executeRunPage)
		.mockResolvedValueOnce(new Date(hour + 10000).toISOString())
		.mockResolvedValueOnce(null);
	const failed = { body: { id: "retry-run" }, attempts: 2, ack: vi.fn(), retry: vi.fn() };
	const next = { body: { id: "next-run" }, attempts: 1, ack: vi.fn(), retry: vi.fn() };
	const pending = consumeFactory(
		{ messages: [failed, next] } as unknown as MessageBatch<unknown>,
		env,
	);
	await vi.runAllTimersAsync();
	await pending;
	expect(send).toHaveBeenCalledTimes(4);
	expect(failed.ack).not.toHaveBeenCalled();
	expect(failed.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 10 });
	expect(next.ack).toHaveBeenCalledOnce();
	expect(next.retry).not.toHaveBeenCalled();
	expect(logFactory).toHaveBeenCalledTimes(5);
	expect(logFactory).toHaveBeenLastCalledWith(
		"factory_consume_error",
		{ runId: "retry-run", attempt: 2, retryDelaySeconds: 10 },
		error,
	);
});

it.each([expireRuns, scheduleRefreshes, dueRuns])(
	"logs scheduled dispatch errors before rethrowing",
	async (operation) => {
		const error = new Error("dispatch unavailable");
		vi.mocked(operation).mockRejectedValueOnce(error);
		const env = { FACTORY_QUEUE: { send: vi.fn() } } as unknown as Env;
		await expect(continueFactory(env, hour)).rejects.toBe(error);
		expect(logFactory).toHaveBeenCalledExactlyOnceWith(
			"factory_continue_error",
			{ scheduledTime: hour, phase: "dispatch" },
			error,
		);
		expect(pruneFactory).toHaveBeenCalledOnce();
	},
);

it("logs both scheduled queue exhaustion and the redispatch failure", async () => {
	const error = { status: 429 };
	const send = vi.fn().mockRejectedValue(error);
	const env = { FACTORY_QUEUE: { send } } as unknown as Env;
	vi.mocked(dueRuns).mockResolvedValueOnce(["retry-run"]);
	const result = expect(continueFactory(env, hour)).rejects.toBe(error);
	await vi.runAllTimersAsync();
	await result;
	expect(send).toHaveBeenCalledTimes(4);
	expect(logFactory).toHaveBeenCalledTimes(5);
	expect(logFactory).toHaveBeenLastCalledWith(
		"factory_continue_error",
		{ scheduledTime: hour, phase: "dispatch" },
		error,
	);
	expect(pruneFactory).toHaveBeenCalledOnce();
});

it("logs retention failure even when scheduled dispatch already failed", async () => {
	const dispatchError = new Error("dispatch unavailable");
	const retentionError = new Error("retention unavailable");
	vi.mocked(expireRuns).mockRejectedValueOnce(dispatchError);
	vi.mocked(pruneFactory).mockRejectedValueOnce(retentionError);
	const env = { FACTORY_QUEUE: { send: vi.fn() } } as unknown as Env;
	await expect(continueFactory(env, hour)).rejects.toBe(retentionError);
	expect(logFactory.mock.calls).toEqual([
		["factory_continue_error", { scheduledTime: hour, phase: "dispatch" }, dispatchError],
		["factory_continue_error", { scheduledTime: hour, phase: "retention" }, retentionError],
	]);
});
