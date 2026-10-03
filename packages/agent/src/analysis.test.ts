import { describe, expect, it } from "vitest";
import { configSchema } from "./config.ts";
import type { Judgment, Observation, SpecialistResult } from "./contracts.ts";
import { buildInput, ownedRepositories } from "./evidence.ts";
import { configuredModels } from "./models.ts";
import { finalizeReport } from "./runtime.ts";

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
	});
});

it("registers distinct planner and executor models on the same provider", () => {
	const models = configuredModels(config);
	expect(models.getModel("faux", "planner")?.api).toBe("openai-completions");
	expect(models.getModel("faux", "worker")?.id).toBe("worker");
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
