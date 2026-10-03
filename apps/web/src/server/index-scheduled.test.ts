import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "./env";
import worker from "./index";
import { continueFactory } from "./lib/factory-dispatch";

vi.mock("./lib/factory-dispatch", () => ({
	consumeFactory: vi.fn(),
	continueFactory: vi.fn(),
}));
afterEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
});

it("forwards the controller scheduled time and registers continuation with waitUntil", async () => {
	vi.useFakeTimers();
	vi.setSystemTime("2026-10-03T11:03:00Z");
	const scheduledTime = Date.parse("2026-10-03T11:00:00Z");
	const continuation = Promise.resolve();
	vi.mocked(continueFactory).mockReturnValueOnce(continuation);
	const env = {} as Env;
	const waitUntil = vi.fn();
	worker.scheduled({ scheduledTime } as ScheduledController, env, {
		waitUntil,
	} as unknown as ExecutionContext);
	expect(continueFactory).toHaveBeenCalledExactlyOnceWith(env, scheduledTime);
	expect(waitUntil).toHaveBeenCalledExactlyOnceWith(continuation);
	await continuation;
});
