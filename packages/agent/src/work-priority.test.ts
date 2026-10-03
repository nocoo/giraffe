import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "./client.ts";
import { configSchema } from "./config.ts";
import { JEV_MAX_REQUEST_BYTES, requestBytes } from "./jev-input.ts";
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
	tasks: [],
	workflows: [],
	limitations: [],
	fetchedAt: "2026-10-03T00:00:00Z",
	stale: false,
};

afterEach(() => vi.unstubAllGlobals());

it("sends exactly the budgeted official SDK wire body including the model field", async () => {
	let projected: unknown;
	const reply = {
		answers: {
			worker: {
				type: "choice",
				choice: "executor_low",
				confidence: 1,
				probabilities: { executor_low: 1, executor_medium: 0, orchestrator_high: 0 },
			},
		},
	};
	await workDecisions(workConfig, async (input) => {
		projected = input;
		return reply;
	}).worker(workRepository);
	const model = 'jev"\\\n😀';
	const config = {
		...workConfig,
		roles: { ...workConfig.roles, decision: { ...workConfig.roles.decision, model } },
	};
	const measured = { ...(projected as object), model };
	config.roles.decision.model += "x".repeat(JEV_MAX_REQUEST_BYTES - requestBytes(measured));
	const send = vi.fn<typeof fetch>(async (_url, init) => {
		expect(Buffer.byteLength(String(init?.body))).toBe(JEV_MAX_REQUEST_BYTES);
		expect(JSON.parse(String(init?.body))).toEqual({
			...(projected as object),
			model: config.roles.decision.model,
		});
		return Response.json({ ...reply, model: "fake", usage: { input_tokens: 1, output_tokens: 1 } });
	});
	vi.stubGlobal("fetch", send);
	await workDecisions(config).worker(workRepository);
	config.roles.decision.model += "x";
	await expect(workDecisions(config).worker(workRepository)).rejects.toThrow(/16385.*16384/);
	expect(send).toHaveBeenCalledTimes(1);
});

it("bounds every priority body, preserves all candidates and leaves originals untouched", async () => {
	const repositories = Array.from({ length: 26 }, (_, index) => ({
		...workRepository,
		repository: `owner/repo${index}`,
		issues: Array.from({ length: 12 }, (_, number) => ({
			...(workRepository.issues[0] as WorkRepository["issues"][number]),
			number: number + 1,
			title: '😀"\\\n'.repeat(300),
		})),
		limitations: Array.from({ length: 20 }, () => "界".repeat(500)),
	}));
	const before = structuredClone(repositories);
	const request = vi.fn(async (input) => {
		expect(requestBytes(input)).toBeLessThanOrEqual(JEV_MAX_REQUEST_BYTES);
		expect(input.model).toBe("jev");
		expect(input.state.repositories[0].limitationsOmitted).toBe(16);
		expect(input.state.repositories[0].limitations).toHaveLength(4);
		return {
			answers: Object.fromEntries(
				Object.entries(input.questions).map(([key, question]) => {
					const criteria = (question as { criteria: Record<string, string> }).criteria;
					expect(Object.keys(criteria)).toHaveLength(13);
					expect(criteria["dependency:1"]).toContain("clipped");
					return [
						key,
						{
							type: "choice",
							choice: "none",
							confidence: 1,
							probabilities: Object.fromEntries(
								Object.keys(criteria).map((id) => [id, id === "none" ? 1 : 0]),
							),
						},
					];
				}),
			),
		};
	});
	const ranked = await workDecisions(workConfig, request).prioritize(repositories);
	expect(request.mock.calls.length).toBeGreaterThan(2);
	expect(ranked.map((repository) => repository.repository)).toEqual(
		repositories.map((repository) => repository.repository),
	);
	expect(ranked[0]?.items).toHaveLength(12);
	expect(ranked[0]?.items[0]?.title).toBe(repositories[0]?.issues[0]?.title);
	expect(repositories).toEqual(before);
});

it("preflights the entire portfolio and routing before any provider call", async () => {
	const request = vi.fn();
	const decisions = workDecisions(workConfig, request);
	const large = {
		...workRepository,
		issues: Array.from({ length: 1000 }, (_, index) => ({
			...(workRepository.issues[0] as WorkRepository["issues"][number]),
			number: index + 1,
		})),
	};
	await expect(decisions.prioritize([workRepository, large])).rejects.toThrow(
		/priority.*owner\/repo.*bytes.*16384/,
	);
	await expect(
		decisions.worker({ ...workRepository, repository: "x".repeat(17000) }),
	).rejects.toThrow(/worker.*bytes.*16384/);
	expect(request).not.toHaveBeenCalled();
	expect(await decisions.prioritize([])).toEqual([]);
});

it("preserves CI candidate identities and full ranked titles", async () => {
	const task: WorkRepository["tasks"][number] = {
		id: "ci:1",
		kind: "ci",
		number: 1,
		title: "CI".repeat(200),
		url: "https://example.test",
		updatedAt: "today",
	};
	const request = vi.fn(async (input) => {
		expect(input.questions.repo_0.criteria["ci:1"]).toContain("clipped");
		return {
			answers: {
				repo_0: {
					type: "choice",
					choice: "ci:1",
					confidence: 1,
					probabilities: { "dependency:1": 0, "ci:1": 1, none: 0 },
				},
			},
		};
	});
	const result = await workDecisions(workConfig, request).prioritize([
		{ ...workRepository, tasks: [task] },
	]);
	expect(result[0]?.items[0]).toEqual({ id: task.id, title: task.title, probability: 1 });
});

it("routes only all ordered authorized tasks with bounded titles and flags", async () => {
	const repository = {
		...workRepository,
		tasks: Array.from({ length: 20 }, (_, index) => ({
			id: `ci:${index}`,
			kind: "ci" as const,
			number: index + 1,
			title: "😀".repeat(500),
			url: "https://example.test",
			updatedAt: "today",
		})),
		limitations: ["limited"],
	};
	const before = structuredClone(repository);
	const request = vi.fn(async (input) => {
		expect(requestBytes(input)).toBeLessThanOrEqual(JEV_MAX_REQUEST_BYTES);
		expect(input.state.repository).toEqual({
			repository: "owner/repo",
			stale: false,
			limited: true,
			tasks: repository.tasks.map(({ id, kind }) => ({
				id,
				kind,
				title: `${"😀".repeat(180)} [clipped 320 codepoints]`,
			})),
		});
		expect(JSON.stringify(input)).not.toMatch(/issues|https:\/\/|updatedAt|workflows/);
		return {
			answers: {
				worker: {
					type: "choice",
					choice: "executor_low",
					confidence: 1,
					probabilities: { executor_low: 1, executor_medium: 0, orchestrator_high: 0 },
				},
			},
		};
	});
	await workDecisions(workConfig, request).worker(repository);
	expect(repository).toEqual(before);
	await expect(
		workDecisions(workConfig, request).worker({
			...repository,
			tasks: Array.from({ length: 1000 }, (_, index) => ({
				...(repository.tasks[0] as WorkRepository["tasks"][number]),
				id: `ci:${index}`,
			})),
		}),
	).rejects.toThrow(/worker.*bytes/);
	expect(request).toHaveBeenCalledTimes(1);
});

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
						choice: "dependency:1",
						confidence: 0.8,
						probabilities: { "dependency:1": 0.8, "pr:2": 0.1, none: 0.1 },
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
	expect(result[0]?.items.map((item) => [item.id, item.probability])).toEqual([
		["dependency:1", 0.8],
		["pr:2", 0.1],
	]);
	const input = calls[0] as {
		state: { repositories: Record<string, unknown>[]; instructions: string };
		questions: Record<string, { instructions: string; criteria: Record<string, string> }>;
	};
	expect(input.state.repositories[0]).toEqual({
		repository: "owner/repo0",
		stale: false,
		fetchedAt: "2026-10-03T00:00:00Z",
		limitations: [],
		limitationsOmitted: 0,
	});
	expect(input.state.instructions).toContain("untrusted");
	expect(input.questions.repo_0?.instructions).toBe(
		"Prioritize the repository at state.repositories[0].",
	);
	expect(input.questions.repo_0?.criteria["dependency:1"]).toBe("Fix test");
	expect(JSON.stringify(input)).not.toContain("github.com");
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
				choice: "dependency:1",
				confidence: 0.8,
				probabilities: { "dependency:1": 0.89, none: 0.1 },
			},
		},
	}));
	const decisions = workDecisions(workConfig, request);
	expect((await decisions.prioritize([workRepository]))[0]?.items[0]?.probability).toBe(0.89);
	request.mockResolvedValueOnce({
		answers: {
			repo_0: {
				type: "choice",
				choice: "dependency:1",
				confidence: 0.8,
				probabilities: { "dependency:1": 0.2, none: 0.1 },
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
					[path.startsWith("issues")
						? "issues"
						: path.startsWith("ci")
							? "streams"
							: "pull_requests"]: [
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
	expect(observation).toHaveBeenCalledTimes(4);
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
						: { issues: [], pull_requests: [], streams: [] },
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
	for (const probabilities of [{ none: 1 }, { none: 0.5, "dependency:1": 0.5, invented: 0 }]) {
		await expect(
			workDecisions(workConfig, async () => ({
				answers: {
					repo_0: { type: "choice", choice: "dependency:1", confidence: 1, probabilities },
				},
			})).prioritize([workRepository]),
		).rejects.toThrow("distribution");
	}
});

it("discovers mixed namespaces and CI-only repositories from saved labels/draft/streams", async () => {
	const at = "2026-10-03T00:00:00Z";
	const client = {
		me: async () => ({ login: "owner" }),
		observation: async (path: string) => ({
			data: path.startsWith("repos")
				? {
						repos: ["mixed", "ci-only"].map((name) => ({
							name_with_owner: `owner/${name}`,
							owner_login: "owner",
						})),
					}
				: path.startsWith("issues")
					? {
							issues: [
								{
									name_with_owner: "owner/mixed",
									number: 1,
									title: "Upgrade dependencies",
									labels: [{ name: "dependencies" }],
									url: "https://github.com/owner/mixed/issues/1",
									updated_at: at,
								},
							],
						}
					: path.startsWith("prs")
						? {
								pull_requests: [
									{
										name_with_owner: "owner/mixed",
										number: 1,
										title: "[CO] simplify",
										is_draft: false,
										url: "https://github.com/owner/mixed/pull/1",
										updated_at: at,
									},
								],
							}
						: {
								streams: ["mixed", "ci-only"].map((name) => ({
									repo: `owner/${name}`,
									workflow: "CI",
									branch: "main",
									scope: "main",
									verdict: "broken",
									streak: 2,
									recurring: true,
									recent: [
										{ id: 1, outcome: "failure", at },
										{ id: 2, outcome: "failure", at },
									],
								})),
							},
			fetchedAt: at,
			truncated: false,
			unavailable: false,
		}),
	};
	const portfolio = await loadPortfolio(client as never, at);
	expect(
		portfolio.find((repo) => repo.repository === "owner/mixed")?.tasks.map((task) => task.id),
	).toEqual(["dependency:1", "pr:1", "ci:1"]);
	expect(
		portfolio.find((repo) => repo.repository === "owner/ci-only")?.tasks.map((task) => task.id),
	).toEqual(["ci:1"]);
});

it("keeps dependency candidates when optional CI snapshot is absent, but never hides other source errors", async () => {
	const observation = vi.fn(async (path: string) => {
		if (path.startsWith("ci")) throw new ApiError(404, "snapshot_missing");
		return {
			data: path.startsWith("repos")
				? { repos: [{ name_with_owner: "owner/repo", owner_login: "owner" }] }
				: { issues: [], pull_requests: [] },
			fetchedAt: null,
			truncated: false,
			unavailable: false,
		};
	});
	const client = { me: async () => ({ login: "owner" }), observation };
	expect((await loadPortfolio(client as never))[0]?.limitations).toEqual([
		expect.stringContaining("CI snapshot"),
	]);
	observation.mockRejectedValueOnce(new ApiError(500, "offline"));
	await expect(loadPortfolio(client as never)).rejects.toThrow("offline");
});

it("expects only recorded main push and workflow_run checks, excluding schedules, PR and tags", async () => {
	const observation = async (path: string) => ({
		data: path.startsWith("repos")
			? { repos: [{ name_with_owner: "owner/repo", owner_login: "owner" }] }
			: path.startsWith("ci")
				? {
						streams: [
							{ workflow: "CI", event: "push", branch: "main" },
							{ workflow: "Release", event: "workflow_run", branch: "main" },
							{ workflow: "Deps", event: "schedule", branch: "main" },
							{ workflow: "Tag publish", event: "push", branch: "v1.0.0" },
							{ workflow: "PR", event: "pull_request", branch: "main" },
						].map(({ workflow, event, branch }) => ({
							repo: "owner/repo",
							branch: "main",
							workflow,
							recent: [{ event, branch }],
						})),
					}
				: { issues: [], pull_requests: [] },
		fetchedAt: null,
		truncated: false,
		unavailable: false,
	});
	const result = await loadPortfolio({
		me: async () => ({ login: "owner" }),
		observation,
	} as never);
	expect(result[0]?.workflows).toEqual(["CI", "Release"]);
});
