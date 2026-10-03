import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, it, vi } from "vitest";
import { configSchema } from "./config.ts";
import { openRuntime } from "./runtime.ts";
import { workDaemon } from "./work-daemon.ts";

const fixture = vi.hoisted(() => ({ path: "", head: "base", pushes: 0, closes: 0 }));
vi.mock("./work-workspace.ts", async (original) => ({
	...(await original<typeof import("./work-workspace.ts")>()),
	WorkWorkspace: class {
		packageRegistry = "https://example.test/npm/";
		inspect = async () => ({
			repository: "owner/repo",
			path: fixture.path,
			branch: "main",
			head: fixture.head,
			status: "",
			diff: "",
			ahead: 0,
			behind: 0,
			checks: ["test"],
			manager: "bun",
			instructions: "",
		});
		prepare = async () => this.inspect();
		files = async () => ["source.ts"];
		changes = async () => "all unpushed commits";
		check = async () => {};
		commit = async () => {
			fixture.head = "approved";
			return fixture.head;
		};
		publish = async () => {
			fixture.pushes++;
		};
		closeIssue = async (workspace: { path: string }) => {
			expect(workspace.path).toBe(fixture.path);
			if (++fixture.closes === 1) throw new Error("closure connection lost");
		};
	},
}));
vi.mock("./github.ts", async (original) => ({
	...(await original<typeof import("./github.ts")>()),
	githubRead: async (path: string) => {
		if (path === "user") return { login: "owner" };
		if (path.endsWith("/issues/1")) {
			if (fixture.pushes) throw new Error("closed issues must not be reverified");
			return {
				number: 1,
				title: "Upgrade dependencies",
				body: "saved evidence",
				state: "open",
				updated_at: "v1",
			};
		}
		if (path.includes("actions/runs"))
			return {
				total_count: 1,
				workflow_runs: [{ head_sha: "approved", status: "completed", conclusion: "success" }],
			};
		return {
			full_name: "owner/repo",
			owner: { login: "owner" },
			fork: false,
			archived: false,
			default_branch: "main",
		};
	},
}));
vi.mock("./work-priority.ts", () => {
	const repository = {
		repository: "owner/repo",
		issues: [
			{
				number: 1,
				title: "Upgrade dependencies",
				url: "https://github.com/owner/repo/issues/1",
				updatedAt: "v1",
			},
		],
		prs: [],
		fetchedAt: "v1",
		stale: false,
		items: [],
		importance: 1,
		confidence: 1,
	};
	return {
		loadPortfolio: async () => [repository],
		workDecisions: () => ({
			prioritize: async () => [repository],
			worker: async () => ({ provider: "faux", model: "sol", thinkingLevel: "low" }),
		}),
	};
});
vi.mock("./work-analysis.ts", () => ({ residentAnalysis: () => async () => {} }));
vi.mock("./retention.ts", () => ({ pruneRemote: async () => {} }));

it("reopens a real coordinator occurrence after push and resumes closure/followup without model or mutation replay", async () => {
	const directory = await mkdtemp(join(tmpdir(), "giraffe-recovery-test-"));
	Object.assign(fixture, { path: directory, head: "base", pushes: 0, closes: 0 });
	await writeFile(join(directory, "source.ts"), "old");
	const config = configSchema.parse({
		providers: {
			faux: { api: "openai-completions", baseUrl: "http://localhost:1", apiKey: "fake" },
			jev: { api: "typesafe-systemone", baseUrl: "http://localhost:2", apiKey: "fake" },
		},
		roles: {
			orchestrator: { provider: "faux", model: "astra" },
			executor: { provider: "faux", model: "sol" },
			decision: { provider: "jev", model: "jev" },
		},
	});
	const models = createModels();
	const fake = fauxProvider({ models: [{ id: "astra" }, { id: "sol" }] });
	models.setProvider(fake.provider);
	const result = (value: unknown) =>
		fauxAssistantMessage([fauxToolCall("submit_work_result", { json: JSON.stringify(value) })], {
			stopReason: "toolUse",
		});
	const action = (operation: string, args: unknown) =>
		fauxAssistantMessage(
			[fauxToolCall("workspace_action", { operation, json: JSON.stringify(args) })],
			{ stopReason: "toolUse" },
		);
	const ready = { summary: "ready", steps: ["tested"], issues: [1], ready: true };
	fake.setResponses([
		result({
			repositories: [
				{ repository: "owner/repo", issues: [1], retainChanges: false, reason: "dependency" },
			],
		}),
		action("prepare", {}),
		result(ready),
		action("write", { path: "source.ts", content: "fixed" }),
		action("commit", { issues: [1], files: ["source.ts"], message: "fix: update dependency" }),
		result(ready),
		result({ head: "approved", findings: [] }),
	]);
	const rows = new Map<string, Record<string, unknown>>();
	const client = {
		get: async (_collection: string, id: string) => rows.get(id) ?? null,
		create: async (_collection: string, value: { id: string }) => {
			rows.set(value.id, value);
		},
		update: async (_collection: string, old: { id: string }, value: Record<string, unknown>) => {
			rows.set(old.id, { ...value, id: old.id });
		},
	};
	try {
		for (let restart = 0; restart < 2; restart++) {
			const runtime = await openRuntime({
				storage: await openNodeSqliteStorage(join(directory, "runtime.sqlite")),
				models,
			});
			const daemon = await workDaemon({
				runtime,
				config,
				client: client as never,
				log: vi.fn(),
				dryRun: false,
				push: true,
				limit: 1,
				once: true,
				wait: async () => {},
			});
			try {
				if (!restart)
					await expect(daemon.tick(undefined, true)).rejects.toThrow("closure connection lost");
				else await daemon.tick(undefined, true);
			} finally {
				await daemon.close();
				await runtime.close();
			}
		}
		expect(fixture.pushes).toBe(1);
		expect(fixture.closes).toBe(2);
		const job = [...rows.values()].find((row) => row.type === "work-run");
		expect(job?.status).toBe("completed");
		expect(job?.payload).toMatchObject({
			repositories: {
				"owner/repo": { head: "approved", followup: { checks: 1, outcome: "passed" } },
			},
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
