import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it, vi } from "vitest";
import { configSchema } from "./config.ts";
import type { AnalysisReport, Judgment, Observation, SpecialistResult } from "./contracts.ts";
import { buildInput, globalInput, ownedRepositories } from "./evidence.ts";
import { configuredModels } from "./models.ts";
import { finalizeReport, openRuntime } from "./runtime.ts";

const now = "2026-10-02T10:00:00.000Z";
const config = configSchema.parse({
	providers: {
		faux: {
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:7024/v1",
			apiKey: "test-key",
		},
		decision: {
			api: "typesafe-systemone",
			baseUrl: "http://127.0.0.1:19823",
			apiKey: "test-key",
		},
	},
	roles: {
		orchestrator: { provider: "faux", model: "planner" },
		executor: { provider: "faux", model: "worker" },
		decision: { provider: "decision", model: "jev-latest" },
	},
});
const judgment: Judgment = {
	model: "jev-test",
	choice: "review",
	confidence: 0.5,
	probabilities: { routine: 0.1, review: 0.7, urgent: 0.1, unknown: 0.1 },
};
const result: SpecialistResult = {
	verdict: "attention",
	summary: "Review the observed issue.",
	findings: [],
	actions: [],
	limitations: [],
};
function observation(
	data: Record<string, unknown>,
	overrides: Partial<Observation> = {},
): Observation {
	return {
		account_id: "test",
		data,
		sourceVersion: "v1",
		fetchedAt: now,
		freshness: { oldestAt: now, latestAt: now, missing: 0 },
		coverage: null,
		truncated: false,
		unavailable: false,
		source: { kind: "snapshot", resource: "test", publicationId: null },
		selection: { scope: "all", statisticsFilter: false },
		...overrides,
	};
}
const input = () =>
	buildInput(
		"owner/repo",
		"issues",
		[
			observation({
				issues: [
					{
						number: 1,
						title: "A failing test",
						url: "https://github.com/owner/repo/issues/1",
						labels: [{ name: "bug" }],
						comments_count: 1,
					},
				],
			}),
		],
		now,
	);

describe("bounded evidence", () => {
	it("filters owned original active candidates and refuses incomplete inventory", () => {
		const catalog = observation({
			repos: [
				{ name_with_owner: "owner/repo", owner_login: "owner" },
				{ name_with_owner: "other/repo", owner_login: "other" },
				{ name_with_owner: "owner/fork", owner_login: "owner", is_fork: true },
				{
					name_with_owner: "owner/archive",
					owner_login: "owner",
					is_archived: true,
				},
			],
		});
		expect(ownedRepositories(catalog, "owner")).toEqual(["owner/repo"]);
		expect(() => ownedRepositories({ ...catalog, truncated: true }, "owner")).toThrow(/incomplete/);
	});
	it("retains counts while bounding evidence and recognizes stale or missing data", () => {
		const data = buildInput(
			"owner/repo",
			"issues",
			[
				observation(
					{
						issues: Array.from({ length: 30 }, (_, number) => ({
							number,
							title: "title",
							url: "javascript:bad",
						})),
					},
					{ freshness: { oldestAt: "2026-09-01T00:00:00.000Z", missing: 1 } },
				),
				{
					resource: "history",
					version: null,
					fetchedAt: null,
					complete: false,
					stale: true,
				},
			],
			now,
		);
		expect(data.counts["issues.total"]).toBe(30);
		expect(data.omitted).toBe(6);
		expect(data.evidence).toHaveLength(24);
		expect(data.evidence[0]?.url).toBeNull();
		expect(data.sources[0]).toMatchObject({ complete: false, stale: true });
		expect(data.limitations.join(" ")).toContain("Missing saved source");
		expect(
			buildInput(
				"owner/repo",
				"ci",
				[
					observation({
						runs: [{ id: 1, name: "CI", conclusion: "failure", status: "completed" }],
					}),
				],
				now,
			).counts["actions.failure"],
		).toBe(1);
		expect(
			buildInput(
				"owner/repo",
				"cd",
				[
					observation({
						releases: [{ id: 1, tag_name: "v1.0.0", published_at: now }],
					}),
				],
				now,
			).evidence[0]?.state,
		).toBe("published");
	});

	it("does not hide latest workflow success behind old failed runs", () => {
		const data = buildInput(
			"owner/repo",
			"ci",
			[
				observation({
					runs: [
						...Array.from({ length: 30 }, (_, id) => ({
							id,
							name: "CI",
							head_branch: "main",
							conclusion: "failure",
							status: "completed",
							created_at: "2026-09-01T00:00:00Z",
						})),
						{
							id: 100,
							name: "CI",
							head_branch: "main",
							conclusion: "success",
							status: "completed",
							created_at: now,
						},
						{
							id: 101,
							name: "Release",
							head_branch: "main",
							conclusion: null,
							status: "in_progress",
							created_at: now,
						},
					],
				}),
			],
			now,
		);
		expect(data.counts["latest-workflows.success"]).toBe(1);
		expect(data.counts["latest-workflows.pending"]).toBe(1);
		expect(data.evidence[0]?.kind).toBe("latest-workflow");
		expect(data.evidence.slice(0, 2).some((entry) => entry.detail.includes("success"))).toBe(true);
		expect(data.evidence[0]?.detail).toContain("observedAt=");
	});
	it("never upgrades stale evidence to a pass or accepts invented citations", () => {
		const stale = input();
		stale.sources[0] = {
			resource: "issues",
			version: "v1",
			fetchedAt: null,
			complete: false,
			stale: true,
		};
		const producer = {
			orchestrator: "planner",
			executor: "worker",
			decision: "jev",
			conversationId: 2,
			jobId: "job",
		};
		expect(
			finalizeReport({ ...result, verdict: "pass" }, stale, judgment, producer, now).verdict,
		).toBe("unknown");
		expect(
			finalizeReport(
				{ ...result, verdict: "pass" },
				{ ...input(), domain: "cd" },
				judgment,
				producer,
				now,
			).verdict,
		).toBe("unknown");
		expect(() =>
			finalizeReport(
				{
					...result,
					findings: [{ title: "x", detail: "x", evidenceIds: ["invented"] }],
				},
				input(),
				judgment,
				producer,
				now,
			),
		).toThrow(/unknown evidence/);
		const report = finalizeReport(result, input(), judgment, producer, now);
		const global = globalInput("issues", [report], ["owner/repo", "owner/missing"], now);
		expect(global.counts.missing).toBe(1);
		expect(global.counts.attention).toBe(1);
		expect(global.sources).toHaveLength(2);
	});
});

it("registers distinct planner and executor models on the same provider", () => {
	const models = configuredModels(config);
	expect(models.getModel("faux", "planner")?.api).toBe("openai-completions");
	expect(models.getModel("faux", "worker")?.id).toBe("worker");
});

it("runs one planner, Jev and a reusable specialist with durable publication", async () => {
	const models = createModels();
	const faux = fauxProvider({ models: [{ id: "planner" }, { id: "worker" }] });
	models.setProvider(faux.provider);
	const roles: string[] = [];
	const calls = [
		[
			"schedule_specialists",
			{ jobId: "job-1", order: ["issues"], rationale: "Inspect the issue." },
		],
		["submit_analysis", { jobId: "job-1", ...result }],
	] as const;
	faux.setResponses(
		calls.map(([name, args], index) => (_context, _options, _state, model) => {
			roles.push(model.id);
			return fauxAssistantMessage([fauxToolCall(name, args, { id: `tool-${index}` })], {
				stopReason: "toolUse",
			});
		}),
	);
	const published: AnalysisReport[] = [];
	const decide = vi.fn(async () => ({ issues: judgment }));
	const runtime = await openRuntime({
		storage: new MemoryStorage(),
		models,
		config,
		decide,
		publish: async (_id, report) => {
			published.push(report);
		},
		now: () => now,
	});
	try {
		const reports = await runtime.run("job-1", [input()]);
		expect(reports).toHaveLength(1);
		expect(roles).toEqual(["planner", "worker"]);
		expect(decide).toHaveBeenCalledOnce();
		expect(published[0]?.producer).toMatchObject({
			orchestrator: "planner",
			executor: "worker",
			decision: "jev-test",
		});
		await runtime.run("job-1", [input()]);
		expect(published).toHaveLength(1);
		await expect(runtime.run("job-1", [{ ...input(), domain: "ci" }])).rejects.toThrow(
			/different evidence/,
		);
	} finally {
		await runtime.close();
	}
});

it("resumes a pending publication after closing and reopening SQLite without new model calls", async () => {
	const directory = await mkdtemp(join(tmpdir(), "giraffe-recovery-"));
	const models = createModels();
	const faux = fauxProvider({ models: [{ id: "planner" }, { id: "worker" }] });
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("schedule_specialists", {
					jobId: "restart",
					order: ["issues"],
					rationale: "Check issues.",
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxToolCall("submit_analysis", { jobId: "restart", ...result })], {
			stopReason: "toolUse",
		}),
	]);
	let reached: () => void = () => {};
	const publishing = new Promise<void>((resolve) => {
		reached = resolve;
	});
	const database = join(directory, "agent.sqlite");
	let runtime = await openRuntime({
		storage: await openNodeSqliteStorage(database),
		models,
		config,
		decide: async () => ({ issues: judgment }),
		publish: async (_id, _report, signal) => {
			reached();
			await new Promise((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(new Error("stopped")), {
					once: true,
				}),
			);
		},
		now: () => now,
	});
	try {
		const running = runtime.run("restart", [input()]);
		const rejected = expect(running).rejects.toThrow();
		await publishing;
		expect(await runtime.pending()).toEqual(["restart"]);
		await expect(runtime.run("another", [input()])).rejects.toThrow(/single orchestrator/);
		await runtime.close();
		await rejected;
		await expect(runtime.run("another", [input()])).rejects.toThrow(/closing/);
		const published: AnalysisReport[] = [];
		runtime = await openRuntime({
			storage: await openNodeSqliteStorage(database),
			models,
			config,
			decide: async () => {
				throw new Error("must not repeat decision");
			},
			publish: async (_id, report) => {
				published.push(report);
			},
			now: () => now,
		});
		const saved = await runtime.job("restart");
		expect(saved?.reports.issues?.summary).toBe(result.summary);
		await runtime.run("restart", saved?.inputs ?? []);
		expect(published).toHaveLength(1);
		expect(faux.state.callCount).toBe(2);
		expect(await runtime.pending()).toEqual([]);
		await runtime.abort("missing");
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

it("fails a job when the orchestrator does not use its scheduling tool", async () => {
	const models = createModels();
	const faux = fauxProvider({ models: [{ id: "planner" }, { id: "worker" }] });
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage("Just text, not a schedule.")]);
	const runtime = await openRuntime({
		storage: new MemoryStorage(),
		models,
		config,
		decide: vi.fn(),
		publish: vi.fn(),
	});
	try {
		await expect(runtime.run("bad-plan", [input()])).rejects.toThrow(/faulted/);
	} finally {
		await runtime.close();
	}
});

it("corrects invalid tool attempts, reuses specialists and supports the global scope", async () => {
	const models = createModels();
	const faux = fauxProvider({ models: [{ id: "planner" }, { id: "worker" }] });
	models.setProvider(faux.provider);
	const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
	faux.setResponses([
		call("schedule_specialists", {
			jobId: "wrong",
			order: ["issues"],
			rationale: "wrong",
		}),
		call("schedule_specialists", {
			jobId: "valid",
			order: ["ci"],
			rationale: "wrong domain",
		}),
		call("schedule_specialists", {
			jobId: "valid",
			order: ["issues"],
			rationale: "correct",
		}),
		call("submit_analysis", { jobId: "wrong", ...result }),
		call("submit_analysis", {
			jobId: "valid",
			...result,
			findings: [{ title: "bad citation", detail: "bad", evidenceIds: ["missing"] }],
		}),
		call("submit_analysis", { jobId: "valid", ...result }),
		call("schedule_specialists", {
			jobId: "again",
			order: ["issues"],
			rationale: "same specialist",
		}),
		call("submit_analysis", { jobId: "again", ...result }),
		call("schedule_specialists", {
			jobId: "global",
			order: ["issues"],
			rationale: "global specialist",
		}),
		call("submit_analysis", { jobId: "global", ...result }),
	]);
	const lines: string[] = [];
	const runtime = await openRuntime({
		storage: new MemoryStorage(),
		models,
		config,
		decide: async () => ({ issues: judgment }),
		publish: async () => {},
		log: (message) => lines.push(message),
		now: () => now,
	});
	try {
		expect(runtime.closing).toBe(false);
		const first = await runtime.run("valid", [input()]);
		const second = await runtime.run("again", [input()]);
		expect(first[0]?.producer.conversationId).toBe(second[0]?.producer.conversationId);
		const global = globalInput("issues", first, ["owner/repo"], now);
		expect((await runtime.run("global", [global]))[0]?.repository).toBeNull();
		expect(lines.join("\n")).toContain("全局/issues");
	} finally {
		await runtime.close();
	}
});

it("fails closed when Jev omits a requested domain or a specialist returns no report", async () => {
	for (const badDecision of [true, false]) {
		const models = createModels();
		const faux = fauxProvider({
			models: [{ id: "planner" }, { id: "worker" }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("schedule_specialists", {
						jobId: "bad",
						order: ["issues"],
						rationale: "inspect",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("No report tool call."),
		]);
		const runtime = await openRuntime({
			storage: new MemoryStorage(),
			models,
			config,
			decide: async () => (badDecision ? {} : { issues: judgment }),
			publish: vi.fn(),
		});
		try {
			await expect(runtime.run("bad", [input()])).rejects.toThrow(/faulted/);
		} finally {
			await runtime.close();
		}
	}
});

it("aborts a durable job and the assigned specialist without orphaning active work", async () => {
	const models = createModels();
	const faux = fauxProvider({ models: [{ id: "planner" }, { id: "worker" }] });
	models.setProvider(faux.provider);
	let ready: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		ready = resolve;
	});
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("schedule_specialists", {
					jobId: "abort",
					order: ["issues"],
					rationale: "inspect",
				}),
			],
			{ stopReason: "toolUse" },
		),
		async (_context, options) => {
			ready();
			await new Promise<void>((resolve) =>
				options?.signal?.addEventListener("abort", () => resolve(), {
					once: true,
				}),
			);
			return fauxAssistantMessage("cancelled");
		},
	]);
	const runtime = await openRuntime({
		storage: new MemoryStorage(),
		models,
		config,
		decide: async () => ({ issues: judgment }),
		publish: vi.fn(),
	});
	try {
		const run = runtime.run("abort", [input()]);
		const rejected = expect(run).rejects.toThrow(/aborted/);
		await started;
		await runtime.abort("abort");
		await rejected;
		await runtime.harness.waitForIdle(BACKGROUND_CONTEXT);
		expect(await runtime.pending()).toEqual([]);
	} finally {
		await runtime.close();
	}
});

it("Jev reorders requested specialists by urgency while retaining every requested domain", async () => {
	const models = createModels();
	const faux = fauxProvider({ models: [{ id: "planner" }, { id: "worker" }] });
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("schedule_specialists", {
					jobId: "order",
					order: ["issues", "ci"],
					rationale: "requested",
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxToolCall("submit_analysis", { jobId: "order", ...result })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxToolCall("submit_analysis", { jobId: "order", ...result })], {
			stopReason: "toolUse",
		}),
	]);
	const runtime = await openRuntime({
		storage: new MemoryStorage(),
		models,
		config,
		decide: async () => ({
			issues: judgment,
			ci: {
				...judgment,
				choice: "urgent",
				confidence: 1,
				probabilities: { urgent: 1, review: 0, unknown: 0, routine: 0 },
			},
		}),
		publish: async () => {},
	});
	try {
		const reports = await runtime.run("order", [input(), { ...input(), domain: "ci" }]);
		expect(reports.map((report) => report.domain)).toEqual(["ci", "issues"]);
	} finally {
		await runtime.close();
	}
});

it("keeps passes scoped to sufficient observations and enforces publication byte limits", () => {
	const producer = {
		orchestrator: "planner",
		executor: "worker",
		decision: "jev",
		conversationId: 1,
		jobId: "job",
	};
	expect(
		finalizeReport({ ...result, verdict: "pass" }, input(), judgment, producer, now).verdict,
	).toBe("pass");
	const prs = {
		...input(),
		domain: "prs" as const,
		counts: { "prs.total": 1 },
	};
	expect(finalizeReport({ ...result, verdict: "pass" }, prs, judgment, producer, now).verdict).toBe(
		"unknown",
	);
	expect(
		finalizeReport({ ...result, verdict: "pass" }, { ...prs, counts: {} }, judgment, producer, now)
			.verdict,
	).toBe("pass");
	const huge = {
		...result,
		findings: Array.from({ length: 8 }, () => ({
			title: "Long evidence",
			detail: "x".repeat(4000),
			evidenceIds: [],
		})),
		actions: Array.from({ length: 6 }, () => ({
			title: "Long action",
			reason: "x".repeat(4000),
			priority: "next" as const,
		})),
		limitations: Array.from({ length: 20 }, (_, i) => `${i}${"x".repeat(950)}`),
	};
	expect(() => finalizeReport(huge, input(), judgment, producer, now)).toThrow(/size budget/);
});

it("stops repeated invalid tool calls after a bounded number of model turns", async () => {
	const models = createModels();
	const faux = fauxProvider({ models: [{ id: "planner" }, { id: "worker" }] });
	models.setProvider(faux.provider);
	faux.setResponses(
		Array.from({ length: 10 }, () =>
			fauxAssistantMessage(
				[
					fauxToolCall("schedule_specialists", {
						jobId: "wrong",
						order: ["issues"],
						rationale: "wrong job",
					}),
				],
				{ stopReason: "toolUse" },
			),
		),
	);
	const runtime = await openRuntime({
		storage: new MemoryStorage(),
		models,
		config,
		decide: vi.fn(),
		publish: vi.fn(),
	});
	try {
		await expect(runtime.run("bounded", [input()])).rejects.toThrow();
		expect(faux.state.callCount).toBeLessThanOrEqual(8);
	} finally {
		await runtime.close();
	}
});
