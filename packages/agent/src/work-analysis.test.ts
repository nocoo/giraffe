import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { ApiError } from "./client.ts";
import { configSchema } from "./config.ts";
import { decisionClient } from "./decision.ts";
import { openRuntime } from "./runtime.ts";
import { combineInputs, residentAnalysis } from "./work-analysis.ts";
import { workConversations } from "./work-conversations.ts";

vi.mock("./decision.ts", () => ({ decisionClient: vi.fn() }));
const workConfig = configSchema.parse({
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
const workRepository = {
	repository: "owner/repo",
	issues: [],
	prs: [],
	tasks: [],
	workflows: [],
	limitations: [],
	fetchedAt: null,
	stale: true,
};

it("freezes analysis evidence and judgment when the same durable occurrence resumes on a later clock", async () => {
	const decide = vi.fn(async (inputs) =>
		Object.fromEntries(
			inputs.map((input: { domain: string }) => [
				input.domain,
				{
					model: "jev",
					choice: "unknown",
					confidence: 1,
					probabilities: { unknown: 1, urgent: 0, review: 0, routine: 0 },
				},
			]),
		),
	);
	vi.mocked(decisionClient).mockReturnValue(decide);
	const models = createModels();
	const fake = fauxProvider({ models: [{ id: "astra" }, { id: "sol" }] });
	models.setProvider(fake.provider);
	fake.setResponses(
		Array.from({ length: 4 }, () =>
			fauxAssistantMessage(
				[
					fauxToolCall("submit_work_result", {
						json: JSON.stringify({
							verdict: "unknown",
							summary: "saved",
							findings: [],
							actions: [],
							limitations: [],
						}),
					}),
				],
				{ stopReason: "toolUse" },
			),
		),
	);
	const config = {
		...workConfig,
		roles: { ...workConfig.roles, executor: { ...workConfig.roles.executor, provider: "faux" } },
	};
	const runtime = await openRuntime({ storage: new MemoryStorage(), models });
	const conversations = workConversations({ runtime, config, log: vi.fn() });
	const observation = vi.fn(async () => ({
		account_id: "owner",
		data: {},
		sourceVersion: "one",
		fetchedAt: "2026-10-03T00:00:00Z",
		freshness: {},
		coverage: null,
		truncated: false,
		unavailable: false,
		source: { resource: "saved", kind: "snapshot", publicationId: null },
		selection: { scope: "all", statisticsFilter: false },
	}));
	try {
		const analyze = residentAnalysis({
			client: { observation } as never,
			config,
			conversations,
			dryRun: true,
			log: vi.fn(),
		});
		await analyze([workRepository], "same-occurrence");
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
		await analyze([workRepository], "same-occurrence");
		expect(decide).toHaveBeenCalledOnce();
		expect(observation).toHaveBeenCalledTimes(5);
	} finally {
		vi.useRealTimers();
		await conversations.close();
		await runtime.close();
	}
});

it("bounds aggregate evidence and makes omissions visible", () => {
	const evidence = Array.from({ length: 30 }, (_, index) => ({
		id: String(index),
		repository: "owner/repo",
		kind: "issue",
		title: "issue",
		state: "open",
		detail: "",
		url: null,
		at: null,
	}));
	const result = combineInputs(
		"issues",
		[
			{
				scope: "repo",
				repository: "owner/repo",
				domain: "issues",
				sourceVersion: "source",
				observedAt: "old",
				sources: [],
				evidence,
				omitted: 2,
				counts: { issues: 30 },
				limitations: [],
			},
		],
		"now",
	);
	expect(result.evidence).toHaveLength(24);
	expect(result.omitted).toBe(8);
	expect(result.limitations).toHaveLength(1);
	expect(combineInputs("cd", [], "now").observedAt).toBe("now");
});

it("runs four resident analysts concurrently, publishes only outside dry run and reports failures", async () => {
	vi.mocked(decisionClient).mockReturnValue(async (inputs) =>
		Object.fromEntries(
			inputs.map((input) => [
				input.domain,
				{
					model: "jev",
					choice: "unknown",
					confidence: 1,
					probabilities: { unknown: 1, urgent: 0, review: 0, routine: 0 },
				},
			]),
		),
	);
	const observation = vi.fn(async () => ({
		account_id: "owner",
		data: {
			issues: [{ name_with_owner: "owner/repo", number: 1 }],
			pull_requests: [{ name_with_owner: "owner/repo", number: 2 }],
			streams: [
				{
					repo: "owner/repo",
					workflow: "CI",
					recent: [{ outcome: "failure", at: "2026-10-03T00:00:00Z" }],
				},
			],
			repos: [{ name: "owner/repo", branch: "main" }],
		},
		sourceVersion: "source",
		fetchedAt: "2026-10-03T00:00:00Z",
		freshness: {},
		coverage: null,
		truncated: false,
		unavailable: false,
		source: { resource: "source", kind: "snapshot", publicationId: null },
		selection: { scope: "all", statisticsFilter: false },
	}));
	const create = vi.fn();
	const run = vi.fn(async () => ({
		conversationId: 1,
		result: {
			verdict: "unknown",
			summary: "Unknown coverage",
			findings: [],
			actions: [],
			limitations: [],
		},
	}));
	const log = vi.fn();
	const options = {
		client: { observation, create, get: async () => null },
		config: workConfig,
		conversations: { run, checkpoint: async () => null, saveCheckpoint: vi.fn() },
		dryRun: true,
		log,
	};
	await residentAnalysis(options as never)([workRepository], "run");
	expect(run.mock.calls).toHaveLength(4);
	expect(create).not.toHaveBeenCalled();
	await residentAnalysis({ ...options, dryRun: false } as never)([workRepository], "run2");
	expect(create).toHaveBeenCalledTimes(4);
	run.mockRejectedValueOnce(new Error("offline"));
	await expect(residentAnalysis(options as never)([workRepository], "run3")).rejects.toThrow();
	expect(log).toHaveBeenCalledWith(expect.stringContaining("offline"));
	observation.mockResolvedValueOnce({ ...(await observation()), data: {} } as never);
	await residentAnalysis(options as never)([workRepository], "missing-rows");
	vi.mocked(decisionClient).mockReturnValueOnce(async () => ({}));
	await expect(
		residentAnalysis(options as never)([workRepository], "missing-judgment"),
	).rejects.toThrow();
	run.mockRejectedValueOnce("not an error");
	await expect(
		residentAnalysis(options as never)([workRepository], "untyped-error"),
	).rejects.toThrow();
	run.mockResolvedValue({
		conversationId: 1,
		result: { verdict: "pass", summary: "partial", findings: [], actions: [], limitations: [] },
	} as never);
	const original = await observation();
	observation.mockResolvedValue({
		...original,
		data: {
			issues: Array.from({ length: 30 }, (_, index) => ({
				name_with_owner: "owner/repo",
				number: index + 1,
			})),
		},
	} as never);
	await residentAnalysis(options as never)([workRepository], "partial-pass");
	observation.mockImplementation(async (path?: string) => {
		if (path?.startsWith("ci") || path?.startsWith("factory"))
			throw new ApiError(404, "snapshot_missing");
		return original;
	});
	await residentAnalysis(options as never)([workRepository], "missing-optional");
	expect(log).toHaveBeenCalledWith(expect.stringContaining("报告保持 unknown"));
	observation.mockRejectedValueOnce(new ApiError(500, "offline"));
	await expect(
		residentAnalysis(options as never)([workRepository], "source-offline"),
	).rejects.toThrow("offline");
});
