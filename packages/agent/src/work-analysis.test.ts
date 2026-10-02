import { expect, it, vi } from "vitest";
import { configSchema } from "./config.ts";
import { decisionClient } from "./decision.ts";
import { combineInputs, residentAnalysis } from "./work-analysis.ts";

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
	fetchedAt: null,
	stale: true,
};

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
		client: { observation, create },
		config: workConfig,
		conversations: { run },
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
});
