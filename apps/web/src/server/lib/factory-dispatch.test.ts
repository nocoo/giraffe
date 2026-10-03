import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { dueRuns } from "./db/factory-runs";
import { consumeFactory, continueFactory, enqueueRun } from "./factory-dispatch";
import { executeRunPage } from "./factory-execute";
import { pruneFactory } from "./factory-retention";
import { scheduleRefreshes } from "./refresh-schedule";

vi.mock("./refresh-schedule", () => ({ scheduleRefreshes: vi.fn() }));
vi.mock("./factory-retention", () => ({ pruneFactory: vi.fn() }));
vi.mock("./factory-execute", () => ({ executeRunPage: vi.fn() }));
vi.mock("./db/factory-runs", () => ({ dueRuns: vi.fn() }));
const hour = Date.parse("2026-10-03T11:00:00Z");
beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(hour);
	vi.mocked(dueRuns).mockResolvedValue([]);
});
afterEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
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

it("uses the event UTC minute for eligibility and wallclock for schedule and cleanup cutoffs", async () => {
	const env = { FACTORY_QUEUE: { send: vi.fn() } } as unknown as Env;
	vi.setSystemTime("2026-10-03T11:03:00Z");
	await continueFactory(env, hour);
	expect(pruneFactory).toHaveBeenLastCalledWith(expect.anything(), "2026-10-03T11:03:00.000Z");
	expect(scheduleRefreshes).toHaveBeenLastCalledWith(env.DB, "2026-10-03T11:03:00.000Z");
	expect(dueRuns).toHaveBeenLastCalledWith(expect.anything(), "2026-10-03T11:03:00.000Z");
	vi.setSystemTime("2026-10-03T12:00:00Z");
	await continueFactory(env, hour + 59 * 60000);
	expect(pruneFactory).toHaveBeenCalledTimes(1);
	expect(scheduleRefreshes).toHaveBeenLastCalledWith(env.DB, "2026-10-03T12:00:00.000Z");
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
	expect(retry).toHaveBeenCalledWith({ delaySeconds: 120 });
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
