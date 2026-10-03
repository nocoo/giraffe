import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { createCron } from "./cron.ts";
import { WorkTransportError } from "./github.ts";
import { openRuntime } from "./runtime.ts";
import { runCoordinator } from "./work-coordinator.ts";
import { verifyWorkIssues, workerActions } from "./work-tools.ts";

vi.mock("./work-tools.ts", () => ({
	verifyWorkIssues: vi.fn(async (_repository, issues) => issues),
	workerActions: vi.fn(() => ({
		committed: [{ issue: 1, head: "committed-head" }],
		action: vi.fn(),
	})),
}));

it("dry-runs workers with ordered issues, workdirs and model choices without workspace mutations", async () => {
	const repositories = [
		{
			repository: "owner/repo",
			issues: [
				{
					number: 1,
					title: "Upgrade dependencies",
					url: "https://github.com/owner/repo/issues/1",
					updatedAt: "today",
				},
			],
			prs: [],
			fetchedAt: "today",
			stale: true,
			importance: 1,
			confidence: 1,
			items: [{ kind: "issue", number: 1, probability: 1 }],
		},
	];
	const inspect = vi.fn(async () => ({
		repository: "owner/repo",
		path: "/personal/repo",
		branch: "main",
		head: "head",
		status: "",
		diff: "",
		ahead: 2,
		behind: 0,
		checks: ["test", "lint"],
		manager: "bun",
		instructions: "",
	}));
	const prepare = vi.fn(),
		publish = vi.fn();
	const run = vi.fn(async (request) => ({
		conversationId: 1,
		result:
			request.key === "controller"
				? {
						repositories: [
							{ repository: "owner/repo", issues: [1], retainChanges: false, reason: "ready" },
						],
					}
				: {
						summary: "rehearsed",
						steps: ["read issue", "test", "commit"],
						issues: [1],
						ready: true,
					},
	}));
	const analyze = vi.fn(async () => {});
	const result = await runCoordinator({
		dryRun: true,
		limit: 1,
		runId: "run",
		load: async () => repositories,
		decisions: {
			prioritize: async () => repositories,
			worker: async () => ({ model: "sol", thinkingLevel: "low" }),
		},
		driver: { inspect, prepare, publish },
		conversations: { run, checkpoint: async () => null, saveCheckpoint: vi.fn() },
		config: { roles: { orchestrator: { model: "astra" }, executor: { model: "sol" } } },
		analyze,
		log: vi.fn(),
	} as never);
	expect(result).toHaveLength(1);
	expect(prepare).not.toHaveBeenCalled();
	expect(publish).not.toHaveBeenCalled();
	expect(analyze).toHaveBeenCalled();
	expect(run.mock.calls.map(([request]) => request.key)).toEqual([
		"controller",
		"preparation",
		"worker:owner/repo",
	]);
	expect(run.mock.calls[2]?.[0]).not.toHaveProperty("action");
});

function fixture() {
	const issue = {
		number: 1,
		title: "Upgrade dependencies",
		url: "https://github.com/owner/repo/issues/1",
		updatedAt: "now",
	};
	const repository = {
		repository: "owner/repo",
		issues: [issue],
		prs: [],
		fetchedAt: "now",
		stale: false,
		importance: 1,
		confidence: 1,
		items: [{ ...issue, kind: "issue", probability: 1 }],
	};
	const workspace = {
		repository: "owner/repo",
		path: "/personal/repo",
		branch: "main",
		head: "head",
		status: " M other",
		diff: "user work",
		ahead: 2,
		behind: 0,
		checks: ["test", "lint"],
		manager: "bun",
		instructions: "",
	};
	const plan = {
		repositories: [
			{ repository: "owner/repo", issues: [1], retainChanges: true, reason: "Keep user work" },
		],
	};
	const run = vi.fn(async (request) => {
		if (request.key === "controller") return { conversationId: 1, result: plan };
		if (request.key === "preparation" && request.action) await request.action("prepare", {});
		return {
			conversationId: 2,
			result: { summary: "done", steps: ["tested"], issues: [1], ready: true },
		};
	});
	return {
		options: {
			dryRun: false,
			limit: 1,
			repositories: ["owner/repo"],
			runId: "run",
			load: async () => [repository],
			decisions: {
				prioritize: async () => [repository],
				worker: async () => ({ model: "sol", thinkingLevel: "low" }),
			},
			driver: {
				inspect: vi.fn(async () => ({ ...workspace, head: "committed-head" })),
				files: vi.fn(async () => []),
				changes: vi.fn(async () => "checked diff"),
				check: vi.fn(async () => {}),
				prepare: vi.fn(async () => workspace),
				publish: vi.fn(async () => {}),
			},
			conversations: {
				checkpoint: async (_key: string): Promise<string | null> => null,
				saveCheckpoint: vi.fn(),
				run: vi.fn(async (request) =>
					request.key.startsWith("reviewer:")
						? { conversationId: 4, result: { head: request.input.head, findings: [] } }
						: run(request),
				),
				reviewState: async () => ({
					round: 0,
					findings: [] as string[],
					head: null as string | null,
				}),
				saveReviewState: vi.fn(),
			},
			config: { roles: { orchestrator: { model: "astra" }, executor: { model: "sol" } } },
			analyze: vi.fn(async () => {}),
			log: vi.fn(),
		},
		plan,
		repository,
		workspace,
	};
}

it("prepares then runs checked workers and publishes only their completed issue list", async () => {
	const { options } = fixture();
	const result = await runCoordinator(options as never);
	expect(options.driver.prepare).toHaveBeenCalledWith(expect.anything(), true, undefined);
	expect(options.driver.publish).toHaveBeenCalledWith(
		expect.anything(),
		"committed-head",
		[1],
		undefined,
	);
	expect(verifyWorkIssues).toHaveBeenCalled();
	expect(result[0]?.dryRun).toBe(false);
	expect(options.conversations.run.mock.calls[2]?.[0]).toHaveProperty("action");
});

it("verifies local completion without push or issue closure when publication is disabled", async () => {
	const { options } = fixture();
	const inspect = options.driver.inspect.getMockImplementation() as NonNullable<
		ReturnType<typeof options.driver.inspect.getMockImplementation>
	>;
	options.driver.inspect
		.mockImplementationOnce(inspect)
		.mockImplementation(async () => ({ ...(await inspect()), head: "committed-head" }));
	const result = await runCoordinator({ ...options, push: false } as never);
	expect(result).toHaveLength(1);
	expect(options.driver.publish).not.toHaveBeenCalled();
	expect(options.log).toHaveBeenCalledWith(expect.stringContaining("不推送、不关闭"));
});

it("rejects mismatched local HEAD even when push is disabled", async () => {
	const { options, workspace } = fixture();
	options.driver.inspect
		.mockImplementationOnce(async () => workspace)
		.mockImplementationOnce(async () => ({ ...workspace, head: "committed-head" }))
		.mockImplementation(async () => workspace);
	await expect(runCoordinator({ ...options, push: false } as never)).resolves.toEqual([]);
	expect(options.log).toHaveBeenCalledWith(expect.stringContaining("local handoff"));
	expect(options.driver.publish).not.toHaveBeenCalled();
});

it("rejects invented/duplicated repositories and omitted/duplicated issues", async () => {
	for (const edit of [
		(plan: ReturnType<typeof fixture>["plan"]) => {
			plan.repositories = [];
		},
		(plan: ReturnType<typeof fixture>["plan"]) => {
			for (const item of plan.repositories) item.repository = "other/repo";
		},
		(plan: ReturnType<typeof fixture>["plan"]) => {
			for (const item of plan.repositories) item.issues = [2];
		},
		(plan: ReturnType<typeof fixture>["plan"]) => {
			plan.repositories.push(...plan.repositories);
		},
	]) {
		const { options, plan } = fixture();
		edit(plan);
		await expect(runCoordinator(options as never)).rejects.toThrow(/Controller/);
		expect(options.driver.publish).not.toHaveBeenCalled();
	}
});

it("skips ineligible or unavailable workspaces and fails visibly without selection", async () => {
	const { options } = fixture();
	options.driver.inspect.mockRejectedValue(new Error("wrong origin"));
	await expect(runCoordinator(options as never)).resolves.toEqual([]);
	expect(options.log).toHaveBeenCalledWith(expect.stringContaining("wrong origin"));
	options.repositories = ["owner/missing"];
	await expect(runCoordinator(options as never)).resolves.toEqual([]);
	options.repositories = ["owner/repo"];
	options.driver.inspect.mockRejectedValue("unknown");
	await expect(runCoordinator(options as never)).resolves.toEqual([]);
});

it("does not accept fictional preparation, incomplete worker handoffs or cancellation", async () => {
	for (const mode of ["prepare", "scope", "ready", "cancel"] as const) {
		const { options } = fixture();
		const original = options.conversations.run.getMockImplementation() as NonNullable<
			ReturnType<typeof options.conversations.run.getMockImplementation>
		>;
		options.conversations.run.mockImplementation(async (request) => {
			if (mode === "prepare" && request.key === "preparation")
				return {
					conversationId: 2,
					result: { summary: "pretend", steps: [], issues: [1], ready: true },
				} as never;
			const result = await original(request);
			if (request.key.startsWith("worker:"))
				return {
					...result,
					result: {
						summary: "blocked",
						steps: [],
						issues: mode === "scope" ? [] : [1],
						ready: mode !== "ready",
					},
				} as never;
			return result;
		});
		const running = runCoordinator({
			...options,
			...(mode === "cancel" ? { signal: AbortSignal.abort() } : {}),
		} as never);
		if (mode === "cancel") await expect(running).rejects.toThrow();
		else await expect(running).resolves.toEqual([]);
		expect(options.driver.publish).not.toHaveBeenCalled();
	}
	const { options } = fixture();
	vi.mocked(workerActions).mockReturnValueOnce({ committed: [], action: vi.fn() });
	await expect(runCoordinator(options as never)).resolves.toEqual([]);
});

it("awaits parallel analysts and propagates failure without reporting successful completion", async () => {
	const { options } = fixture();
	options.dryRun = true;
	options.analyze.mockRejectedValue(new Error("analysis failed"));
	await expect(runCoordinator(options as never)).rejects.toThrow(/Resident analysis failed/);
});

it("retries independent findings and forbids reviewer writes", async () => {
	const { options } = fixture();
	const run = options.conversations.run.getMockImplementation();
	if (!run) throw new Error("Missing fixture.");
	let reviews = 0;
	options.conversations.run.mockImplementation(async (request) => {
		if (request.key.startsWith("reviewer:")) {
			await expect(request.action("write", {})).rejects.toThrow("read-only");
			await request.action("read", { path: "code.ts" });
			return {
				conversationId: 4,
				result: { head: request.input.head, findings: ++reviews === 1 ? ["fix cause"] : [] },
			} as never;
		}
		return run(request);
	});
	const observe = vi.fn();
	await runCoordinator({ ...options, observe } as never);
	expect(observe).toHaveBeenCalledWith(
		"owner/repo",
		expect.objectContaining({
			worker: 2,
			reviewer: 4,
			round: 2,
			head: "committed-head",
			status: "pushed",
		}),
	);
	expect(reviews).toBe(2);
	expect(options.driver.publish).toHaveBeenCalledTimes(1);
	expect(options.conversations.saveReviewState).toHaveBeenLastCalledWith(
		expect.stringContaining("task-"),
		{
			round: 2,
			findings: [],
			head: "committed-head",
		},
	);
});

it("does not push when independent findings exhaust all rounds", async () => {
	const { options } = fixture();
	const run = options.conversations.run.getMockImplementation();
	if (!run) throw new Error("Missing fixture.");
	options.conversations.run.mockImplementation(async (request) =>
		request.key.startsWith("reviewer:")
			? ({
					conversationId: 4,
					result: { head: "committed-head", findings: ["still broken"] },
				} as never)
			: run(request),
	);
	await expect(runCoordinator(options as never)).resolves.toEqual([]);
	expect(options.driver.publish).not.toHaveBeenCalled();
});

it("resumes approved state without another worker or a missing handoff after push", async () => {
	const { options } = fixture();
	options.conversations.reviewState = async () => ({
		round: 20,
		findings: [],
		head: "committed-head",
	});
	const result = await runCoordinator(options as never);
	expect(
		options.conversations.run.mock.calls.some(([request]) => request.key.startsWith("worker:")),
	).toBe(false);
	expect(options.driver.publish).toHaveBeenCalledOnce();
	expect(result[0]?.summary).toContain("Recovered");
});

it("rejects unknown preparation actions and repeated prepare", async () => {
	const { options } = fixture();
	const run = options.conversations.run.getMockImplementation();
	if (!run) throw new Error("Missing fixture.");
	options.conversations.run.mockImplementation(async (request) => {
		if (request.key === "preparation") {
			await expect(request.action("shell", {})).rejects.toThrow("Only one");
			await request.action("prepare", {});
			await expect(request.action("prepare", {})).rejects.toThrow("Only one");
			return {
				conversationId: 2,
				result: { summary: "ready", steps: ["baseline"], issues: [1], ready: true },
			} as never;
		}
		return run(request);
	});
	await runCoordinator(options as never);
});

it("resumes frozen plan, prepared workspace and approval after restart without replaying tools", async () => {
	const { options } = fixture();
	const saved = new Map<string, string>();
	options.conversations.checkpoint = async (key: string) => saved.get(key) ?? null;
	options.conversations.saveCheckpoint.mockImplementation(async (key, json) => {
		saved.set(key, json);
	});
	options.driver.publish.mockRejectedValueOnce(new Error("transport failed"));
	await expect(runCoordinator(options as never)).rejects.toThrow("transport failed");
	options.conversations.reviewState = async () => ({
		round: 1,
		findings: [],
		head: "committed-head",
	});
	options.conversations.run.mockClear();
	options.driver.prepare.mockClear();
	const result = await runCoordinator(options as never);
	expect(result[0]?.summary).toContain("Recovered");
	expect(options.driver.prepare).not.toHaveBeenCalled();
	expect(options.conversations.run).not.toHaveBeenCalled();
});

it("persists actual worker tool completion before interruption", async () => {
	const { options } = fixture();
	const run = options.conversations.run.getMockImplementation();
	if (!run) throw new Error("Missing fixture.");
	options.conversations.run.mockImplementation(async (request) => {
		if (request.key.startsWith("worker:")) await request.action("check", {});
		return run(request);
	});
	await runCoordinator(options as never);
	expect(
		options.conversations.saveCheckpoint.mock.calls.some(
			(call) => JSON.parse(call[1]).committed["owner/repo"]?.length === 1,
		),
	).toBe(true);
});

it("never treats ordinary issues or report-only PRs as executable dependency work", async () => {
	const { options, repository } = fixture();
	const issue = repository.issues[0];
	if (!issue) throw new Error("Missing fixture issue.");
	issue.title = "Build a new feature";
	await expect(runCoordinator(options as never)).resolves.toEqual([]);
	expect(options.driver.prepare).not.toHaveBeenCalled();
});

it("shares terminal task identity across occurrences and priority order, but not changed evidence", async () => {
	const { options, repository } = fixture();
	const firstIssue = repository.issues[0];
	if (!firstIssue) throw new Error("Missing issue.");
	repository.issues.push({ ...firstIssue, number: 2 });
	const saved = new Map<string, string>();
	options.conversations.checkpoint = async (key) => saved.get(key) ?? null;
	options.conversations.saveCheckpoint.mockImplementation(async (key, json) => {
		saved.set(key, json);
	});
	let order = [1, 2];
	options.conversations.run.mockImplementation(async (request) => {
		if (request.key === "controller")
			return {
				conversationId: 1,
				result: {
					repositories: [
						{ repository: "owner/repo", issues: order, retainChanges: true, reason: "priority" },
					],
				},
			} as never;
		throw new Error("blocked preparation");
	});
	await runCoordinator(options as never);
	const first = options.conversations.run.mock.calls.length;
	options.runId = "second-occurrence";
	order = [2, 1];
	await runCoordinator(options as never);
	expect(options.conversations.run.mock.calls.length).toBe(first + 1);
	firstIssue.updatedAt = "changed";
	options.runId = "third-occurrence";
	await runCoordinator(options as never);
	expect(options.conversations.run.mock.calls.length).toBe(first + 3);
});

it("keeps reviewed local work publishable in a later occurrence without another fix", async () => {
	const { options } = fixture();
	const saved = new Map<string, string>();
	options.conversations.checkpoint = async (key) => saved.get(key) ?? null;
	options.conversations.saveCheckpoint.mockImplementation(async (key, json) => {
		saved.set(key, json);
	});
	await runCoordinator({ ...options, push: false } as never);
	expect([...saved.values()].some((json) => JSON.parse(json).status === "locally_reviewed")).toBe(
		true,
	);
	options.runId = "later-live-occurrence";
	options.conversations.reviewState = async () => ({
		round: 1,
		head: "committed-head",
		findings: [],
	});
	options.conversations.run.mockClear();
	await runCoordinator(options as never);
	expect(options.driver.publish).toHaveBeenCalledOnce();
	expect(
		options.conversations.run.mock.calls.some(([request]) => request.key.startsWith("worker:")),
	).toBe(false);
});

it("does not cache a transport verification failure as terminal work", async () => {
	const { options } = fixture();
	vi.mocked(verifyWorkIssues).mockRejectedValueOnce(new WorkTransportError("offline"));
	await expect(runCoordinator(options as never)).rejects.toThrow("offline");
	expect(
		options.conversations.saveCheckpoint.mock.calls.some(([key]) => key.startsWith("task-")),
	).toBe(false);
	await runCoordinator(options as never);
	expect(options.driver.publish).toHaveBeenCalledOnce();
});

it("skips a recovered published repository before verifying its now closed issues", async () => {
	const { options } = fixture();
	const saved = new Map<string, string>();
	options.conversations.checkpoint = async (key) => saved.get(key) ?? null;
	options.conversations.saveCheckpoint.mockImplementation(async (key, json) => {
		saved.set(key, json);
	});
	options.driver.publish.mockRejectedValueOnce(new Error("closure failed after push"));
	await expect(runCoordinator(options as never)).rejects.toThrow("closure failed");
	vi.mocked(verifyWorkIssues).mockClear();
	await runCoordinator({ ...options, completedPublications: ["owner/repo"] } as never);
	expect(verifyWorkIssues).not.toHaveBeenCalled();
});

it("finishes exhausted repositories over two cron occurrences and restarts only changed source tasks", async () => {
	const { options, repository } = fixture();
	const saved = new Map<string, string>();
	options.conversations.checkpoint = async (key) => saved.get(key) ?? null;
	options.conversations.saveCheckpoint.mockImplementation(async (key, json) => {
		saved.set(key, json);
	});
	const review = { round: 0, findings: [] as string[], head: null as string | null };
	options.conversations.reviewState = async () => review;
	options.conversations.saveReviewState.mockImplementation(async (_key, value) => {
		Object.assign(review, value);
	});
	const run = options.conversations.run.getMockImplementation();
	if (!run) throw new Error("Missing model fixture.");
	options.conversations.run.mockImplementation(async (request) =>
		request.key.startsWith("reviewer:")
			? ({
					conversationId: 4,
					result: { head: "committed-head", findings: ["test cause still unresolved"] },
				} as never)
			: run(request),
	);
	const runtime = await openRuntime({ storage: new MemoryStorage(), models: createModels() });
	let now = "2026-10-03T00:00:00Z";
	const statuses: { completed: number }[] = [];
	const cron = await createCron({
		harness: runtime.harness,
		expression: "0 * * * *",
		timezone: "UTC",
		enabled: true,
		maxRounds: 20,
		now: () => now,
		isPaused: async () => false,
		publish: async (status) => {
			statuses.push(status);
		},
		run: async (runId) => {
			await runCoordinator({ ...options, runId } as never);
		},
	});
	try {
		await cron.tick(undefined, true);
		expect(review.round).toBe(20);
		const workers = () =>
			options.conversations.run.mock.calls.filter(([request]) => request.key.startsWith("worker:"))
				.length;
		expect(workers()).toBe(20);
		now = "2026-10-03T01:00:00Z";
		await cron.tick(undefined, true);
		expect(workers()).toBe(20);
		expect(statuses.at(-1)?.completed).toBe(2);
		const issue = repository.issues[0];
		if (!issue) throw new Error("Missing issue.");
		issue.updatedAt = "new-evidence";
		Object.assign(review, { round: 0, findings: [], head: null });
		now = "2026-10-03T02:00:00Z";
		await cron.tick(undefined, true);
		expect(workers()).toBe(40);
		expect(statuses.at(-1)?.completed).toBe(3);
		expect(options.driver.publish).not.toHaveBeenCalled();
	} finally {
		await runtime.close();
	}
});
