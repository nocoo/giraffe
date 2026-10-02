import { afterEach, expect, it, vi } from "vitest";
import { ApiError, GiraffeClient } from "./client.ts";
import { configSchema } from "./config.ts";
import type {
	CronStatus,
	DependencyPlan,
	IssueCandidate,
	RepairProgress,
} from "./repair-contracts.ts";
import { repairDecision } from "./repair-decision.ts";
import {
	assertSameIssue,
	dependencyCandidates,
	type GithubRead,
	githubRead,
	packageTarget,
	verifyLiveIssue,
} from "./repair-source.ts";
import { repairTelemetry } from "./repair-telemetry.ts";

const now = "2026-10-02T00:00:00.000Z";
const config = configSchema.parse({
	providers: {
		models: { api: "openai-completions", baseUrl: "http://localhost:1", apiKey: "test" },
		decision: { api: "typesafe-systemone", baseUrl: "http://localhost:2", apiKey: "test" },
	},
	roles: {
		orchestrator: { provider: "models", model: "astra" },
		executor: { provider: "models", model: "sol" },
		decision: { provider: "decision", model: "jev" },
	},
});
const candidate: IssueCandidate = {
	repository: "owner/repo",
	number: 1,
	title: "deps demo2.0.0",
	url: "https://github.com/owner/repo/issues/1",
	labels: ["dependencies"],
	updatedAt: now,
	fetchedAt: now,
	sourceVersion: "source",
};
const envelope = (data: Record<string, unknown>) => ({
	account_id: "a",
	data,
	sourceVersion: "v",
	fetchedAt: now,
	freshness: null,
	coverage: null,
	truncated: false,
	unavailable: false,
	source: { kind: "snapshot", resource: "issues", publicationId: null },
	selection: { scope: "all" as const, statisticsFilter: false },
});
const client = () =>
	new GiraffeClient({
		baseUrl: "https://example.test",
		token: "fake",
		account_id: "a",
		expires_at: "2099-01-01T00:00:00Z",
		scopes: [],
	});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
it("discovers bounded fresh dependency candidates without trusting labels as authorization", async () => {
	const c = client();
	vi.spyOn(c, "me").mockResolvedValue({
		account_id: "a",
		login: "owner",
		token: { id: "t", scopes: [], expires_at: "2099" },
	});
	const issue = {
		name_with_owner: "owner/repo",
		number: 1,
		title: candidate.title,
		url: candidate.url,
		updated_at: now,
		labels: [{ name: "dependencies" }],
	};
	const observation = vi
		.spyOn(c, "observation")
		.mockResolvedValueOnce(
			envelope({ repos: [{ name_with_owner: "owner/repo", owner_login: "owner" }] }),
		)
		.mockResolvedValueOnce(
			envelope({
				issues: [
					issue,
					issue,
					{ ...issue, number: 2, title: "feature", labels: [] },
					{ ...issue, name_with_owner: "other/repo" },
					{ ...issue, number: "invalid" },
				],
			}),
		);
	expect(await dependencyCandidates(c, config, now)).toHaveLength(1);
	observation
		.mockResolvedValueOnce(envelope({ repos: [] }))
		.mockResolvedValueOnce({ ...envelope({ issues: [] }), truncated: true });
	await expect(dependencyCandidates(c, config, now)).rejects.toThrow(/incomplete/);
	observation
		.mockResolvedValueOnce(
			envelope({ repos: [{ name_with_owner: "owner/repo", owner_login: "owner" }] }),
		)
		.mockResolvedValueOnce(
			envelope({
				issues: [{ ...issue, title: "Upgrade demo", labels: undefined }],
				repository_fetched_at: { "owner/repo": "2020-01-01T00:00:00Z" },
			}),
		);
	expect(await dependencyCandidates(c, config, now)).toEqual([]);
	observation
		.mockResolvedValueOnce(envelope({ repos: [] }))
		.mockResolvedValueOnce(
			envelope({ issues: [{ name_with_owner: 42, title: null, labels: [] }] }),
		);
	expect(await dependencyCandidates(c, config, now)).toEqual([]);
	observation
		.mockResolvedValueOnce(
			envelope({ repos: [{ name_with_owner: "owner/repo", owner_login: "owner" }] }),
		)
		.mockResolvedValueOnce({ ...envelope({ issues: [issue] }), fetchedAt: null });
	expect(await dependencyCandidates(c, config, now)).toEqual([]);
});
function readFixture(): GithubRead {
	return vi.fn(async (path) =>
		path === "user"
			? { login: "owner" }
			: path.endsWith("/issues/1")
				? {
						number: 1,
						title: candidate.title,
						body: "demo2.0.0",
						state: "open",
						html_url: candidate.url,
						updated_at: now,
						labels: [{ name: "dependencies" }],
						user: { login: "owner" },
					}
				: path.includes("/branches/")
					? { commit: { sha: "a".repeat(40) } }
					: {
							id: 1,
							full_name: "owner/repo",
							owner: { login: "owner" },
							archived: false,
							fork: false,
							default_branch: "main",
						},
	);
}
it("verifies current identity/repository/issue/default SHA and rejects changes before push", async () => {
	const read = readFixture();
	const issue = await verifyLiveIssue(candidate, "owner", read);
	const noBody = readFixture();
	expect(
		(
			await verifyLiveIssue(candidate, "owner", async (path) =>
				path.includes("issues")
					? { ...((await noBody(path)) as object), body: null }
					: noBody(path),
			)
		).body,
	).toBe("");
	expect(issue.baseSha).toBe("a".repeat(40));
	expect(() => assertSameIssue(issue, issue)).not.toThrow();
	expect(() => assertSameIssue(issue, { ...issue, body: "changed" })).toThrow(/changed/);
	await expect(verifyLiveIssue(candidate, "wrong", readFixture())).rejects.toThrow(/identity/);
	for (const override of [{ archived: true }, { fork: true }, { disabled: true }]) {
		const base = readFixture();
		const custom: GithubRead = async (path, signal) => {
			const raw = await base(path, signal);
			return path === "repos/owner/repo" ? { ...(raw as object), ...override } : raw;
		};
		await expect(verifyLiveIssue(candidate, "owner", custom)).rejects.toThrow(/eligible/);
	}
	const base = readFixture();
	await expect(
		verifyLiveIssue(candidate, "owner", async (path) =>
			path.includes("issues") ? { ...((await base(path)) as object), state: "closed" } : base(path),
		),
	).rejects.toThrow(/no longer/);
	await expect(githubRead("invalid;rm")).rejects.toThrow(/Invalid/);
	await expect(
		verifyLiveIssue(candidate, "owner", async (path) =>
			path.includes("issues")
				? { ...((await base(path)) as object), updated_at: "2026-10-03T00:00:00Z" }
				: base(path),
		),
	).rejects.toThrow(/changed/);
});
it("verifies exact registry metadata and keeps uncertain Jev decisions out of scope", async () => {
	const plan: DependencyPlan = {
		decision: "repair",
		reason: "upgrade",
		manifest: "package.json",
		section: "dependencies",
		dependency: "demo",
		targetVersion: "2.0.0",
		provenance: "original",
		provenanceReason: "owner",
	};
	await packageTarget(
		plan,
		"https://registry.test",
		vi.fn(async () => Response.json({ name: "demo", version: "2.0.0" })),
	);
	await expect(packageTarget(plan, "http://registry.test")).rejects.toThrow(/HTTPS/);
	await expect(
		packageTarget(
			plan,
			"https://registry.test",
			vi.fn(async () => Response.json({}, { status: 404 })),
		),
	).rejects.toThrow(/verified/);
	await expect(
		packageTarget(
			plan,
			"https://registry.test",
			vi.fn(async () => Response.json({ name: "other", version: "2.0.0" })),
		),
	).rejects.toThrow(/mismatch/);
	const issue = await verifyLiveIssue(candidate, "owner", readFixture());
	const fetcher = vi.fn(async () =>
		Response.json({
			model: "jev-test",
			usage: { input_tokens: 1, output_tokens: 1 },
			answers: {
				eligible: {
					type: "choice",
					choice: "dependency_upgrade",
					confidence: 0.9,
					probabilities: { dependency_upgrade: 0.95, other: 0.02, unknown: 0.03 },
				},
			},
		}),
	);
	vi.stubGlobal("fetch", fetcher);
	expect((await repairDecision(config)(issue)).eligible).toBe(true);
	fetcher.mockResolvedValueOnce(
		Response.json({
			model: "jev",
			usage: { input_tokens: 1, output_tokens: 1 },
			answers: {
				eligible: {
					type: "choice",
					choice: "unknown",
					confidence: 0.5,
					probabilities: { dependency_upgrade: 0.4, other: 0.1, unknown: 0.5 },
				},
			},
		}),
	);
	expect((await repairDecision(config)(issue)).eligible).toBe(false);
	expect(() => repairDecision({ ...config, providers: {} })).toThrow(/missing/);
	fetcher.mockResolvedValueOnce(
		Response.json({
			model: "jev",
			usage: { input_tokens: 1, output_tokens: 1 },
			answers: {
				eligible: {
					type: "choice",
					choice: "unknown",
					confidence: 0.5,
					probabilities: { dependency_upgrade: 0.9, other: 0.9, unknown: 0.9 },
				},
			},
		}),
	);
	await expect(repairDecision(config)(issue)).rejects.toThrow();
});
it("publishes revisioned repair progress and does not overwrite newer telemetry", async () => {
	const c = client();
	const get = vi.spyOn(c, "get").mockResolvedValue(null);
	const create = vi.spyOn(c, "create").mockResolvedValue({} as never);
	const update = vi.spyOn(c, "update").mockResolvedValue({} as never);
	const telemetry = repairTelemetry(c);
	const progress = {
		id: "deps-1",
		stage: "fixing",
		repository: "owner/repo",
		sequence: 1,
	} as RepairProgress;
	await telemetry.progress(progress);
	expect(create).toHaveBeenCalledOnce();
	get.mockResolvedValue({ id: "deps-1", payload: { sequence: 2 } } as never);
	await telemetry.progress(progress);
	expect(update).not.toHaveBeenCalled();
	await telemetry.progress({ ...progress, sequence: 3 });
	expect(update).toHaveBeenCalledOnce();
	await telemetry.cron({ state: "idle" } as CronStatus);
	expect(update).toHaveBeenCalledTimes(2);
	get.mockResolvedValue({ payload: { paused: true } } as never);
	expect(await telemetry.paused()).toBe(true);
	get.mockRejectedValueOnce(new ApiError(404, "not_found"));
	expect(await telemetry.paused()).toBe(false);
	get.mockRejectedValueOnce(new ApiError(500, "error"));
	await expect(telemetry.paused()).rejects.toThrow("500");
});
