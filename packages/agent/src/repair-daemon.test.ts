import { afterEach, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
	run: vi.fn(),
	close: vi.fn(),
	verify: vi.fn(),
	package: vi.fn(),
	cron: vi.fn(),
	candidates: vi.fn(),
	paused: vi.fn(),
	telemetry: vi.fn(),
	driver: vi.fn(),
	sandbox: vi.fn(),
	trace: vi.fn(),
}));
vi.mock("./repair-workspace.ts", () => ({
	WorkspaceDriver: class {
		constructor(input: unknown) {
			mocked.driver(input);
		}
	},
}));
vi.mock("./repair-engine.ts", () => ({
	createRepairEngine: (input: unknown) => {
		mocked.telemetry(input);
		return { run: mocked.run, trace: mocked.trace };
	},
}));
vi.mock("./repair-models.ts", () => ({
	repairModels: (input: { onEvent: (id: string, message: string) => Promise<void> }) => ({
		close: mocked.close,
		notify: input.onEvent,
	}),
}));
vi.mock("./repair-decision.ts", () => ({ repairDecision: () => vi.fn() }));
vi.mock("./repair-source.ts", () => ({
	dependencyCandidates: mocked.candidates,
	verifyLiveIssue: mocked.verify,
	packageTarget: mocked.package,
}));
vi.mock("./repair-telemetry.ts", () => ({
	repairTelemetry: () => ({ progress: vi.fn(), cron: vi.fn(), paused: mocked.paused }),
}));
vi.mock("./repair-sandbox.ts", () => ({
	dockerSandbox: mocked.sandbox,
	hostGitTransport: vi.fn(),
}));
vi.mock("./cron.ts", () => ({
	createCron: mocked.cron,
	nextOccurrence: () => "2026-10-03T00:00:00Z",
}));

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { GiraffeClient } from "./client.ts";
import { configSchema } from "./config.ts";
import type { createCron } from "./cron.ts";
import { repairDaemon } from "./repair-daemon.ts";
import type { RepairEngineOptions } from "./repair-engine.ts";
import type { AgentRuntime } from "./runtime.ts";

afterEach(() => vi.clearAllMocks());
const base = {
	providers: {
		models: { api: "openai-completions", baseUrl: "http://localhost:1", apiKey: "fake" },
		jev: { api: "typesafe-systemone", baseUrl: "http://localhost:2", apiKey: "fake" },
	},
	roles: {
		orchestrator: { provider: "models", model: "astra" },
		executor: { provider: "models", model: "sol" },
		decision: { provider: "jev", model: "jev" },
	},
};
it("wires persistent cron, source verification, execution and telemetry without secrets", async () => {
	for (const sandbox of [undefined, { image: "tools:1", registry: "https://registry.test" }]) {
		const config = configSchema.parse({
			...base,
			repairs: { enabled: true, ...(sandbox ? { sandbox } : {}) },
		});
		mocked.cron.mockResolvedValue({ tick: vi.fn() });
		mocked.candidates.mockResolvedValue([{ repository: "owner/repo" }]);
		mocked.paused.mockResolvedValue(false);
		const daemon = await repairDaemon({
			config,
			client: { me: async () => ({ login: "owner" }) } as GiraffeClient,
			runtime: {
				harness: await Harness.open(
					new MemoryStorage(),
					{ models: createModels(), registry: createRegistry() },
					BACKGROUND_CONTEXT,
				),
			} as AgentRuntime,
			log: vi.fn(),
		});
		const cron = mocked.cron.mock.lastCall?.[0] as Parameters<typeof createCron>[0];
		await cron.run("occurrence", new AbortController().signal);
		expect(mocked.run).toHaveBeenCalled();
		const engine = mocked.telemetry.mock.lastCall?.[0] as RepairEngineOptions;
		expect(engine.prerequisite?.({ repository: "other/repo" } as never)).toContain("profile");
		expect((await engine.admit({ repository: "unconfigured/repo" } as never)).eligible).toBe(false);
		await engine.verify({} as never);
		await engine.verifyPackage({} as never);
		expect(mocked.verify).toHaveBeenCalled();
		expect(mocked.package).toHaveBeenCalled();
		const model = engine.models as typeof engine.models & {
			notify(id: string, message: string): Promise<void>;
		};
		await model.notify("id", "tool");
		expect(mocked.trace).toHaveBeenCalledWith("id", "tool");
		await cron.run("occurrence", AbortSignal.abort());
		mocked.paused.mockResolvedValue(true);
		await cron.run("occurrence", new AbortController().signal);
		await daemon.close();
		expect(mocked.close).toHaveBeenCalled();
	}
});

it("requires both a trusted profile and sandbox before consulting Jev", async () => {
	for (const sandbox of [undefined, { image: "tools:1", registry: "https://registry.test" }]) {
		const config = configSchema.parse({
			...base,
			repairs: {
				enabled: true,
				profiles: {
					"owner/repo": {
						manager: "npm",
						checks: ["test"],
						files: ["package.json"],
						hooksPath: ".husky",
					},
				},
				...(sandbox ? { sandbox } : {}),
			},
		});
		mocked.cron.mockResolvedValue({});
		await repairDaemon({
			config,
			client: { me: async () => ({ login: "owner" }) } as GiraffeClient,
			runtime: { harness: {} } as AgentRuntime,
			log: vi.fn(),
		});
		const engine = mocked.telemetry.mock.lastCall?.[0] as RepairEngineOptions;
		expect(engine.prerequisite?.({ repository: "owner/repo" } as never)).toBe(
			sandbox ? null : "No isolated execution image configured; discovery only, no edits or push.",
		);
		const result = await engine.admit({ repository: "owner/repo" } as never);
		if (!sandbox) expect(result.eligible).toBe(false);
		else expect(result).toBeUndefined();
	}
});
