import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, expect, it, vi } from "vitest";
import { createCron, nextOccurrence } from "./cron.ts";
import type { CronStatus } from "./repair-contracts.ts";

afterEach(() => {
	vi.useRealTimers();
});
const open = (storage = new MemoryStorage()) =>
	Harness.open(storage, { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
it("uses wall clock timezone and rejects nondeterministic or sub-minute schedules", () => {
	expect(nextOccurrence("0 8 * * *", "Asia/Shanghai", "2026-10-02T00:00:00Z")).toBe(
		"2026-10-03T00:00:00.000Z",
	);
	expect(nextOccurrence("*/15 * * * *", "UTC", "2026-10-02T00:14:30Z")).toBe(
		"2026-10-02T00:15:00.000Z",
	);
	for (const cron of ["* * * * * *", "H * * * *", "@hourly", "90 * * * *"])
		expect(() => nextOccurrence(cron, "UTC", "2026-01-01T00:00:00Z")).toThrow();
	expect(() => nextOccurrence("0 * * * *", "invalid/zone", "2026-01-01T00:00:00Z")).toThrow();
});
it("coalesces missed ticks, honors pause and never overlaps a running occurrence", async () => {
	const harness = await open();
	let now = "2026-10-02T00:01:00.000Z";
	let paused = false;
	const states: CronStatus[] = [];
	const run = vi.fn(async () => {});
	const cron = await createCron({
		harness,
		expression: "0 * * * *",
		timezone: "UTC",
		enabled: true,
		maxRounds: 20,
		run,
		now: () => now,
		publish: async (value) => {
			states.push(value);
		},
		isPaused: async () => paused,
	});
	try {
		await cron.tick();
		expect(run).not.toHaveBeenCalled();
		now = "2026-10-03T08:01:00.000Z";
		await cron.tick();
		expect(run).toHaveBeenCalledOnce();
		expect(states.at(-1)?.nextRunAt).toBe("2026-10-03T09:00:00.000Z");
		await cron.tick();
		expect(run).toHaveBeenCalledOnce();
		paused = true;
		await cron.tick(undefined, true);
		expect(run).toHaveBeenCalledOnce();
		paused = false;
		let done: () => void = () => {};
		run.mockImplementationOnce(
			async () =>
				new Promise<void>((resolve) => {
					done = resolve;
				}),
		);
		const first = cron.tick(undefined, true);
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
		await cron.tick(undefined, true);
		expect(run).toHaveBeenCalledTimes(2);
		done();
		await first;
		await cron.tick(AbortSignal.abort());
		expect(run).toHaveBeenCalledTimes(2);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});
it("retains a failed occurrence across SQLite reopen and applies changed schedule afterward", async () => {
	const dir = await mkdtemp(join(tmpdir(), "giraffe-cron-"));
	const database = join(dir, "state.sqlite");
	const models = createModels();
	const registry = createRegistry();
	let harness = await Harness.open(
		await openNodeSqliteStorage(database),
		{ models, registry },
		BACKGROUND_CONTEXT,
	);
	const ids: string[] = [];
	const opts = {
		expression: "0 * * * *",
		timezone: "UTC",
		enabled: true,
		maxRounds: 20,
		now: () => "2026-10-02T00:01:00.000Z",
		publish: vi.fn(async (_value: CronStatus) => {}),
		isPaused: async () => false,
	};
	try {
		const first = await createCron({
			...opts,
			harness,
			run: async (id) => {
				ids.push(id);
				throw new Error("network");
			},
		});
		await first.tick(undefined, true);
		await harness.close(BACKGROUND_CONTEXT);
		harness = await Harness.open(
			await openNodeSqliteStorage(database),
			{ models, registry },
			BACKGROUND_CONTEXT,
		);
		const second = await createCron({
			...opts,
			expression: "30 * * * *",
			harness,
			run: async (id) => {
				ids.push(id);
			},
		});
		await second.tick();
		expect(ids[0]).toBe(ids[1]);
		expect(opts.publish.mock.lastCall?.[0]).toMatchObject({
			state: "idle",
			completed: 1,
			nextRunAt: "2026-10-02T00:30:00.000Z",
		});
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	}
});
it("publishes offline on shutdown and keeps disabled schedules dormant", async () => {
	const harness = await open();
	const published: CronStatus[] = [];
	const cron = await createCron({
		harness,
		expression: "0 * * * *",
		timezone: "UTC",
		enabled: false,
		maxRounds: 20,
		run: vi.fn(),
		publish: async (state) => {
			published.push(state);
		},
		isPaused: async () => false,
	});
	try {
		await cron.tick(undefined, true);
		await cron.serve(AbortSignal.abort());
		expect(published.at(-1)?.state).toBe("offline");
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

it("publishes live heartbeats and preserves cancellation without catch-up storms", async () => {
	vi.useFakeTimers();
	const harness = await open();
	const controller = new AbortController();
	const states: CronStatus[] = [];
	const cron = await createCron({
		harness,
		expression: "* * * * *",
		timezone: "UTC",
		enabled: true,
		maxRounds: 20,
		run: vi.fn(),
		publish: async (state) => {
			states.push(state);
		},
		isPaused: async () => false,
	});
	try {
		vi.spyOn(cron, "tick").mockResolvedValue();
		const serving = cron.serve(controller.signal);
		await vi.advanceTimersByTimeAsync(10000);
		expect(states.length).toBeGreaterThan(0);
		controller.abort();
		await serving;
		expect(states.at(-1)?.state).toBe("offline");
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

it("recovers heartbeat and scheduler connection errors without silently advancing the schedule", async () => {
	vi.useFakeTimers();
	const harness = await open();
	const controller = new AbortController();
	const log = vi.fn();
	const publish = vi.fn(async () => {
		throw new Error("offline");
	});
	const cron = await createCron({
		harness,
		expression: "0 * * * *",
		timezone: "UTC",
		enabled: true,
		maxRounds: 20,
		run: vi.fn(),
		publish,
		isPaused: async () => false,
		log,
	});
	try {
		const serving = cron.serve(controller.signal);
		await vi.advanceTimersByTimeAsync(12000);
		controller.abort();
		await serving;
		expect(log.mock.calls.flat().join(" ")).toContain("连接失败");
		expect(log.mock.calls.flat().join(" ")).toContain("暂时无法上报");
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

it("retains active occurrence when cancellation happens inside the callback", async () => {
	for (const failure of [false, true]) {
		const harness = await open();
		const controller = new AbortController();
		const reports: CronStatus[] = [];
		const cron = await createCron({
			harness,
			expression: "* * * * *",
			timezone: "UTC",
			enabled: true,
			maxRounds: 20,
			isPaused: async () => false,
			publish: async (state) => {
				reports.push(state);
			},
			run: async () => {
				controller.abort();
				if (failure) throw new Error("aborted");
			},
		});
		try {
			await cron.tick(controller.signal, true);
			await cron.publish();
			expect(reports.at(-1)?.activeOccurrence).not.toBeNull();
			expect(reports.at(-1)?.completed).toBe(0);
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	}
});
