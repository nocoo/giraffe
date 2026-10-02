import { expect, it, vi } from "vitest";
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
					title: "Fix",
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
		conversations: { run },
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
		title: "Fix",
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
				inspect: vi.fn(async () => workspace),
				files: vi.fn(async () => []),
				check: vi.fn(async () => {}),
				prepare: vi.fn(async () => workspace),
				publish: vi.fn(async () => {}),
			},
			conversations: { run },
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
	const { options } = fixture();
	await expect(runCoordinator({ ...options, push: false } as never)).rejects.toThrow(
		/local handoff/,
	);
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
	await expect(runCoordinator(options as never)).rejects.toThrow(/No eligible/);
	expect(options.log).toHaveBeenCalledWith(expect.stringContaining("wrong origin"));
	options.repositories = ["owner/missing"];
	await expect(runCoordinator(options as never)).rejects.toThrow(/No eligible/);
	options.repositories = ["owner/repo"];
	options.driver.inspect.mockRejectedValue("unknown");
	await expect(runCoordinator(options as never)).rejects.toThrow(/No eligible/);
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
		await expect(
			runCoordinator({
				...options,
				...(mode === "cancel" ? { signal: AbortSignal.abort() } : {}),
			} as never),
		).rejects.toThrow();
		expect(options.driver.publish).not.toHaveBeenCalled();
	}
	const { options } = fixture();
	vi.mocked(workerActions).mockReturnValueOnce({ committed: [], action: vi.fn() });
	await expect(runCoordinator(options as never)).rejects.toThrow(/committed/);
});

it("awaits parallel analysts and propagates failure without reporting successful completion", async () => {
	const { options } = fixture();
	options.dryRun = true;
	options.analyze.mockRejectedValue(new Error("analysis failed"));
	await expect(runCoordinator(options as never)).rejects.toThrow(/Resident analysis failed/);
});
