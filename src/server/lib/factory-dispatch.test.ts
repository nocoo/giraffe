import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { dueRuns } from "./db/factory-runs";
import { consumeFactory, continueFactory, enqueueRun } from "./factory-dispatch";
import { executeRunPage } from "./factory-execute";

vi.mock("./factory-retention", () => ({ pruneFactory: vi.fn() }));
vi.mock("./factory-execute", () => ({ executeRunPage: vi.fn() }));
vi.mock("./db/factory-runs", () => ({ dueRuns: vi.fn() }));
afterEach(() => vi.clearAllMocks());
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
	await continueFactory(env);
	expect(send).toHaveBeenLastCalledWith({ id: "orphan" }, { delaySeconds: 0 });
});
