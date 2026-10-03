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

const fixture = vi.hoisted(() => ({
	path: "",
	head: "base",
	pushes: 0,
	closes: 0,
	kind: "dependency",
}));
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
		expectedWorkflows = async () => ["CI"];
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
		if (path.endsWith("/actions/runs/1"))
			return {
				id: 1,
				head_sha: "a".repeat(40),
				head_branch: "main",
				status: "completed",
				conclusion: "failure",
				workflow_id: 1,
				path: ".github/workflows/ci.yml",
				run_attempt: 1,
				repository: { full_name: "owner/repo", default_branch: "main" },
			};
		if (path.includes("/actions/runs/1/jobs"))
			return {
				total_count: 1,
				jobs: [
					{
						id: 1,
						run_id: 1,
						head_sha: "a".repeat(40),
						run_attempt: 1,
						name: "unit tests",
						status: "completed",
						conclusion: "failure",
						steps: [{ number: 1, name: "test", status: "completed", conclusion: "failure" }],
					},
				],
			};
		if (path.endsWith("/issues/1")) {
			if (fixture.pushes) throw new Error("closed issues must not be reverified");
			return {
				id: "dependency:1",
				kind: "dependency",
				number: 1,
				title: "Upgrade dep to 2.0.0",
				labels: [],
				html_url: "https://github.com/owner/repo/issues/1",
				body: "saved evidence",
				state: "open",
				updated_at: "2026-10-03T00:00:00Z",
			};
		}
		if (path.includes("actions/runs"))
			return {
				total_count: 1,
				workflow_runs: [
					{ head_sha: "approved", status: "completed", conclusion: "success", name: "CI" },
				],
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
		tasks: [
			{
				id: "dependency:1",
				kind: "dependency",
				number: 1,
				title: "Upgrade dependencies",
				url: "https://github.com/owner/repo/issues/1",
				updatedAt: "2026-10-03T00:00:00Z",
			},
		],
		prs: [],
		issues: [],
		workflows: ["CI"],
		choice: "dependency:1",
		fetchedAt: "v1",
		stale: false,
		items: [],
		importance: 1,
		confidence: 1,
	};
	return {
		loadPortfolio: async () => [
			{
				...repository,
				tasks:
					fixture.kind === "ci"
						? [
								{
									id: "ci:1",
									kind: "ci",
									number: 1,
									title: "Investigate CI",
									url: "https://github.com/owner/repo/actions/runs/1",
									updatedAt: "2026-10-03T00:00:00Z",
								},
							]
						: repository.tasks,
			},
		],
		workDecisions: () => ({
			prioritize: async (portfolio: unknown[]) => portfolio,
			worker: async () => ({ provider: "faux", model: "sol", thinkingLevel: "low" }),
		}),
	};
});
vi.mock("./work-analysis.ts", () => ({ residentAnalysis: () => async () => {} }));
vi.mock("./retention.ts", () => ({ pruneRemote: async () => {} }));

it.each(["dependency", "ci"])(
	"reopens a real %s coordinator occurrence and resumes publication without model or mutation replay",
	async (kind) => {
		const directory = await mkdtemp(join(tmpdir(), "giraffe-recovery-test-"));
		Object.assign(fixture, { path: directory, head: "base", pushes: 0, closes: 0, kind });
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
		const taskId = `${kind}:1`;
		const ready = { summary: "ready", steps: ["tested"], tasks: [taskId], ready: true };
		fake.setResponses([
			result({
				repositories: [
					{
						repository: "owner/repo",
						tasks: [taskId],
						retainChanges: false,
						reason: "dependency",
					},
				],
			}),
			action("prepare", {}),
			result(ready),
			action("write", { path: "source.ts", content: "fixed" }),
			action("commit", {
				tasks: [taskId],
				files: ["source.ts"],
				message: "fix: update dependency",
			}),
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
			for (let restart = 0; restart < (kind === "ci" ? 1 : 2); restart++) {
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
					if (!restart && kind === "dependency")
						await expect(daemon.tick(undefined, true)).rejects.toThrow("closure connection lost");
					else await daemon.tick(undefined, true);
				} finally {
					await daemon.close();
					await runtime.close();
				}
			}
			expect(fixture.pushes).toBe(1);
			expect(fixture.closes).toBe(kind === "dependency" ? 2 : 0);
			const job = [...rows.values()].find((row) => row.type === "work-run");
			expect(job?.status).toBe("completed");
			expect(job?.payload).toMatchObject({
				repositories: {
					"owner/repo": {
						tasks: [taskId],
						head: "approved",
						workerModel: "sol / low",
						followup: { checks: 1, outcome: "passed" },
					},
				},
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);
