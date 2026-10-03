import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, expect, it, vi } from "vitest";
import { configSchema } from "./config.ts";
import { githubRead } from "./github.ts";
import { openRuntime } from "./runtime.ts";
import { runCoordinator } from "./work-coordinator.ts";
import { workDaemon } from "./work-daemon.ts";
import { loadPortfolio } from "./work-priority.ts";

vi.mock("./work-coordinator.ts", () => ({ runCoordinator: vi.fn() }));
vi.mock("./work-analysis.ts", () => ({ residentAnalysis: vi.fn(() => vi.fn()) }));
vi.mock("./work-priority.ts", () => ({ loadPortfolio: vi.fn(), workDecisions: vi.fn() }));
vi.mock("./work-workspace.ts", () => ({
	WorkWorkspace: class {
		private log: (line: string) => void;
		constructor(options: { log: (line: string) => void }) {
			this.log = options.log;
		}
		publish = vi.fn(async () => {});
		expectedWorkflows = async () => ["CI"];
		closeIssue = vi.fn(async () => {});
		check = async () => {
			this.log("[执行结果] tests passed HEAD=abc");
		};
	},
}));
vi.mock("./github.ts", () => ({ githubRead: vi.fn() }));
vi.mock("./retention.ts", () => ({ pruneRemote: vi.fn(async () => {}) }));
afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

const config = configSchema.parse({
	providers: {
		model: { api: "openai-completions", baseUrl: "http://localhost:1", apiKey: "fake" },
		jev: { api: "typesafe-systemone", baseUrl: "http://localhost:2", apiKey: "fake" },
	},
	roles: {
		orchestrator: { provider: "model", model: "astra" },
		executor: { provider: "model", model: "sol" },
		decision: { provider: "jev", model: "jev" },
	},
});

async function fixture(dryRun = false) {
	vi.mocked(loadPortfolio).mockResolvedValue([]);
	const runtime = await openRuntime({
		storage: new MemoryStorage(),
		models: createModels(),
	});
	const rows = new Map<
		string,
		{ id: string; type: string; status: string; payload: Record<string, unknown> }
	>();
	const client = {
		get: vi.fn(async (_collection, id) => rows.get(id) ?? null),
		create: vi.fn(async (_collection, value) => {
			rows.set(value.id, { ...value });
		}),
		update: vi.fn(async (_collection, old, value) => {
			rows.set(old.id, { ...value, id: old.id });
		}),
	};
	const daemon = await workDaemon({
		config,
		runtime,
		client: client as never,
		log: vi.fn(),
		dryRun,
		push: true,
		limit: 5,
		wait: async () => {},
	});
	return { runtime, client, rows, daemon };
}

it("freezes active authority and propagates once failures before any new tools", async () => {
	vi.mocked(runCoordinator).mockRejectedValue(new Error("blocked"));
	const { runtime, client, daemon } = await fixture();
	try {
		await daemon.tick(undefined, true);
		const changed = await workDaemon({
			config,
			runtime,
			client: client as never,
			log: vi.fn(),
			dryRun: false,
			push: false,
			limit: 5,
			once: true,
		});
		try {
			await expect(changed.tick(undefined, true)).rejects.toThrow("mode/scope changed");
		} finally {
			await changed.close();
		}
		expect(runCoordinator).toHaveBeenCalledTimes(1);
	} finally {
		await daemon.close();
		await runtime.close();
	}
});

it("respects pause and records upsert failures without losing local run completion", async () => {
	vi.mocked(runCoordinator).mockImplementation(async (options) => {
		await options.load();
		options.log("trace");
		return [];
	});
	const { runtime, rows, client, daemon } = await fixture();
	try {
		rows.set("work-control", {
			id: "work-control",
			type: "work-control",
			status: "paused",
			payload: { paused: true },
		});
		await daemon.tick(undefined, true);
		expect(runCoordinator).not.toHaveBeenCalled();
		rows.delete("work-control");
		client.update.mockRejectedValueOnce(new Error("offline"));
		await expect(daemon.tick(undefined, true)).rejects.toThrow("offline");
		await daemon.tick(undefined, true);
	} finally {
		await daemon.close();
		await runtime.close();
	}
});

it("completes no-work occurrences, byte-bounds telemetry and never writes in dry run", async () => {
	vi.mocked(runCoordinator).mockImplementation(async (options) => {
		options.observe?.("owner/repo", {
			tasks: ["dependency:1"],
			worker: 7,
			reviewer: 8,
			round: 2,
			findings: [],
			head: "abc",
			status: "signed_off",
		});
		await options.driver.check({} as never);
		for (let index = 0; index < 100; index++) options.log("汉".repeat(2000));
		return [];
	});
	for (const dryRun of [false, true]) {
		const { runtime, client, rows, daemon } = await fixture(dryRun);
		try {
			await daemon.tick(undefined, true);
			if (dryRun) expect(client.create).not.toHaveBeenCalled();
			else {
				const job = [...rows.values()].find((row) => row.type === "work-run");
				expect(job?.status).toBe("completed");
				expect(Buffer.byteLength(JSON.stringify(job?.payload))).toBeLessThan(64000);
				expect(rows.get("work-cron")?.payload.completed).toBe(1);
				expect(job?.payload.repositories).toMatchObject({
					"owner/repo": { worker: 7, reviewer: 8, head: "abc" },
				});
			}
		} finally {
			await daemon.close();
			await runtime.close();
		}
	}
});

it("persists push and follow-up then resumes without duplicate publication after failure", async () => {
	vi.useFakeTimers();
	vi.mocked(githubRead).mockResolvedValue({
		workflow_runs: [{ head_sha: "head", status: "completed", conclusion: "success", name: "CI" }],
	});
	let attempts = 0;
	vi.mocked(runCoordinator).mockImplementation(async (options) => {
		await options.driver.publish(
			{ repository: "owner/repo", expectedWorkflows: ["CI"] } as never,
			"head",
			[1],
		);
		if (++attempts === 1) throw new Error("report failed after push");
		return [];
	});
	const { runtime, rows, daemon } = await fixture();
	try {
		const first = daemon.tick(undefined, true);
		await vi.advanceTimersByTimeAsync(600001);
		await first;
		await daemon.tick(undefined, true);
		expect(githubRead).toHaveBeenCalledTimes(1);
		expect(rows.get("work-cron")?.payload.completed).toBe(1);
		const job = [...rows.values()].find((row) => row.type === "work-run");
		expect(job?.status).toBe("completed");
	} finally {
		await daemon.close();
		await runtime.close();
	}
});

it("heartbeats during injected follow-up wait and flushes terminal progress last", async () => {
	vi.useFakeTimers();
	vi.mocked(githubRead).mockResolvedValue({ workflow_runs: [] });
	vi.mocked(runCoordinator).mockImplementation(async (options) => {
		options.observe?.("owner/repo", {
			tasks: ["dependency:1"],
			worker: 7,
			reviewer: 8,
			round: 1,
			findings: [],
			head: "head",
			status: "signed_off",
		});
		await options.driver.publish(
			{ repository: "owner/repo", expectedWorkflows: ["CI"] } as never,
			"head",
			[1],
		);
		return [];
	});
	const { runtime, client, rows, daemon } = await fixture();
	let release: () => void = () => {};
	const waiting = await workDaemon({
		config,
		runtime,
		client: client as never,
		log: vi.fn(),
		dryRun: false,
		push: true,
		limit: 5,
		wait: async () =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	});
	try {
		const tick = waiting.tick(undefined, true);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(11000);
		release();
		await vi.advanceTimersByTimeAsync(0);
		release();
		await vi.advanceTimersByTimeAsync(0);
		release();
		await tick;
		const job = [...rows.values()].find((row) => row.type === "work-run");
		expect(job?.status).toBe("attention");
		await vi.advanceTimersByTimeAsync(20000);
		expect(job?.status).toBe("attention");
	} finally {
		await waiting.close();
		await daemon.close();
		await runtime.close();
	}
});

it("rejects changed recovered publication HEAD and reports failed trace uploads safely", async () => {
	let head = "one";
	vi.mocked(githubRead).mockResolvedValue({
		workflow_runs: [{ head_sha: "one", status: "completed", conclusion: "success", name: "CI" }],
	});
	vi.mocked(runCoordinator).mockImplementation(async (options) => {
		await options.load();
		await options.driver.publish(
			{ repository: "owner/repo", expectedWorkflows: ["CI"] } as never,
			head,
			[],
		);
		throw new Error("retry");
	});
	const { runtime, client, daemon } = await fixture();
	try {
		await daemon.tick(undefined, true);
		head = "changed";
		await daemon.tick(undefined, true);
		client.create.mockRejectedValueOnce(new Error("offline"));
		await daemon.tick(undefined, true);
	} finally {
		await daemon.close();
		await runtime.close();
	}
});

it("completed local occurrence can be acknowledged again without another coordinator run", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
	vi.mocked(runCoordinator).mockResolvedValue([]);
	const { runtime, daemon } = await fixture();
	try {
		await daemon.tick(undefined, true);
		await daemon.tick(undefined, true);
		expect(runCoordinator).toHaveBeenCalledTimes(1);
	} finally {
		await daemon.close();
		await runtime.close();
	}
});

it("retries only persisted terminal delivery after final Web upload fails", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
	vi.mocked(runCoordinator).mockImplementation(async (options) => {
		options.observe?.("owner/repo", {
			tasks: ["dependency:1"],
			worker: 7,
			reviewer: 8,
			round: 20,
			findings: ["exhausted"],
			head: null,
			status: "exhausted",
		});
		return [];
	});
	const { runtime, client, rows, daemon } = await fixture();
	const update = client.update.getMockImplementation();
	if (!update) throw new Error("Missing update fixture.");
	let fail = true;
	let terminal: unknown;
	client.update.mockImplementation(async (collection, old, value) => {
		if (value.type === "work-run" && value.status === "attention" && fail) {
			fail = false;
			terminal = structuredClone(value.payload);
			throw new Error("Web offline");
		}
		return update(collection, old, value);
	});
	try {
		await daemon.tick(undefined, true);
		await vi.advanceTimersByTimeAsync(15000);
		await daemon.tick(undefined, true);
		expect(runCoordinator).toHaveBeenCalledOnce();
		const job = [...rows.values()].find((row) => row.type === "work-run");
		expect(job?.status).toBe("attention");
		expect(job?.payload).toEqual(terminal);
	} finally {
		await daemon.close();
		await runtime.close();
	}
});

it("finishes missing optional analysis sources as attention instead of pinning the work occurrence", async () => {
	vi.mocked(runCoordinator).mockImplementation(async (options) => {
		options.log("[分析证据缺失] ci/factory unknown");
		options.analysisAttention?.();
		return [];
	});
	const { runtime, rows, daemon } = await fixture();
	try {
		await daemon.tick(undefined, true);
		expect(rows.get("work-cron")?.payload.completed).toBe(1);
		expect([...rows.values()].find((row) => row.type === "work-run")?.status).toBe("attention");
	} finally {
		await daemon.close();
		await runtime.close();
	}
});
