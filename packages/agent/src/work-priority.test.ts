import { expect, it, vi } from "vitest";
import { configSchema } from "./config.ts";
import { loadPortfolio, type WorkRepository, workDecisions } from "./work-priority.ts";

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
const workRepository: WorkRepository = {
	repository: "owner/repo",
	issues: [
		{
			number: 1,
			title: "Fix test",
			url: "https://github.com/owner/repo/issues/1",
			updatedAt: "2026-10-03T00:00:00Z",
		},
	],
	prs: [],
	fetchedAt: "2026-10-03T00:00:00Z",
	stale: false,
};

it("asks once per repository in batches of 25 and preserves every issue/PR", async () => {
	const calls: unknown[] = [];
	const request = vi.fn(async (input: { questions: Record<string, unknown> }) => {
		calls.push(input);
		return {
			answers: Object.fromEntries(
				Object.keys(input.questions).map((key) => [
					key,
					{
						type: "choice",
						choice: "issue_1",
						confidence: 0.8,
						probabilities: { issue_1: 0.8, pr_2: 0.1, none: 0.1 },
					},
				]),
			),
		};
	});
	const repository = {
		...workRepository,
		prs: [{ ...(workRepository.issues[0] as WorkRepository["issues"][number]), number: 2 }],
	};
	const result = await workDecisions(workConfig, request).prioritize(
		Array.from({ length: 26 }, (_, index) => ({ ...repository, repository: `owner/repo${index}` })),
	);
	expect(request).toHaveBeenCalledTimes(2);
	expect(Object.keys((calls[0] as { questions: object }).questions)).toHaveLength(25);
	expect(result).toHaveLength(26);
	expect(result[0]?.items.map((item) => [item.kind, item.number, item.probability])).toEqual([
		["issue", 1, 0.8],
		["pr", 2, 0.1],
	]);
});

it("restricts model/think selection and rejects incomplete Jev answers", async () => {
	const request = vi
		.fn()
		.mockResolvedValueOnce({
			answers: {
				worker: {
					type: "choice",
					choice: "executor_medium",
					confidence: 1,
					probabilities: { executor_low: 0, executor_medium: 1, orchestrator_high: 0 },
				},
			},
		})
		.mockResolvedValue({ answers: {} });
	const decisions = workDecisions(workConfig, request);
	expect(await decisions.worker(workRepository)).toMatchObject({
		model: "sol",
		thinkingLevel: "medium",
	});
	await expect(decisions.prioritize([workRepository])).rejects.toThrow();
	await expect(decisions.worker(workRepository)).rejects.toThrow();
});

it("accepts bounded provider rounding without inventing missing probabilities", async () => {
	const request = vi.fn(async () => ({
		answers: {
			repo_0: {
				type: "choice",
				choice: "issue_1",
				confidence: 0.8,
				probabilities: { issue_1: 0.89, none: 0.1 },
			},
		},
	}));
	const decisions = workDecisions(workConfig, request);
	expect((await decisions.prioritize([workRepository]))[0]?.items[0]?.probability).toBe(0.89);
	request.mockResolvedValueOnce({
		answers: {
			repo_0: {
				type: "choice",
				choice: "issue_1",
				confidence: 0.8,
				probabilities: { issue_1: 0.2, none: 0.1 },
			},
		},
	});
	await expect(decisions.prioritize([workRepository])).rejects.toThrow(/distribution/);
});

it("loads saved catalog, issues and PRs without losing coverage or inventing freshness", async () => {
	const observation = vi.fn(async (path: string) => ({
		data: path.startsWith("repos")
			? { repos: [{ name_with_owner: "owner/repo", owner_login: "owner" }] }
			: {
					[path.startsWith("issues") ? "issues" : "pull_requests"]: [
						{
							name_with_owner: "owner/repo",
							number: 1,
							title: "Task",
							url: "https://github.com/owner/repo/issues/1",
							updated_at: "2026-10-01T00:00:00Z",
						},
					],
				},
		fetchedAt: "2026-10-01T00:00:00Z",
		truncated: false,
		unavailable: false,
	}));
	const client = { me: async () => ({ login: "owner" }), observation };
	const result = await loadPortfolio(client as never, "2026-10-03T00:00:00Z");
	expect(result[0]).toMatchObject({ repository: "owner/repo", stale: true });
	expect(result[0]?.prs).toHaveLength(1);
	expect(observation).toHaveBeenCalledTimes(3);
	observation.mockResolvedValueOnce({
		data: {},
		fetchedAt: "",
		truncated: true,
		unavailable: false,
	} as never);
	await expect(loadPortfolio(client as never)).rejects.toThrow();
});

it("keeps absent, invalid and future timestamps unknown and validates provider and distributions", async () => {
	for (const fetchedAt of [null, "invalid", "2027-01-01T00:00:00Z"]) {
		const result = await loadPortfolio(
			{
				me: async () => ({ login: "owner" }),
				observation: async (path: string) => ({
					data: path.startsWith("repos")
						? { repos: [{ name_with_owner: "owner/repo", owner_login: "owner" }] }
						: { issues: [], pull_requests: [] },
					fetchedAt,
					unavailable: false,
					truncated: false,
				}),
			} as never,
			"2026-10-03T00:00:00Z",
		);
		expect(result[0]?.stale).toBe(true);
	}
	expect(() => workDecisions({ ...workConfig, providers: {} })).toThrow("provider missing");
	for (const probabilities of [{ none: 1 }, { none: 0.5, issue_1: 0.5, invented: 0 }]) {
		await expect(
			workDecisions(workConfig, async () => ({
				answers: { repo_0: { type: "choice", choice: "issue_1", confidence: 1, probabilities } },
			})).prioritize([workRepository]),
		).rejects.toThrow("distribution");
	}
});
