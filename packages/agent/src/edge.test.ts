import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GiraffeClient } from "./client.ts";
import { configSchema, homeDirectory, writePrivateJson } from "./config.ts";
import type { AnalysisReport, Domain, Observation } from "./contracts.ts";
import { decisionClient } from "./decision.ts";
import { buildInput, collectInput, globalInput, object, validReports } from "./evidence.ts";
import { acquireInstance } from "./instance.ts";
import { configuredModels } from "./models.ts";

const directories: string[] = [];
const temp = () => {
	const directory = mkdtempSync(join(tmpdir(), "giraffe-edge-"));
	directories.push(directory);
	return directory;
};
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
const now = "2026-10-02T10:00:00.000Z";
const config = configSchema.parse({
	providers: {
		models: {
			api: "openai-completions",
			baseUrl: "http://localhost:1",
			apiKey: "test",
		},
		jev: {
			api: "typesafe-systemone",
			baseUrl: "http://localhost:2",
			apiKey: "test",
		},
	},
	roles: {
		orchestrator: { provider: "models", model: "planner" },
		executor: { provider: "models", model: "worker" },
		decision: { provider: "jev", model: "jev-latest" },
	},
});
const envelope = (
	data: Record<string, unknown>,
	changes: Partial<Observation> = {},
): Observation => ({
	account_id: "a",
	data,
	sourceVersion: "v",
	fetchedAt: now,
	freshness: null,
	coverage: null,
	truncated: false,
	unavailable: false,
	source: { kind: "snapshot", resource: "source", publicationId: null },
	selection: { scope: "all", statisticsFilter: false },
	...changes,
});
const credential = {
	baseUrl: "http://localhost:2",
	token: "test",
	account_id: "a",
	expires_at: "2099-01-01T00:00:00.000Z",
	scopes: [],
};

it("uses an OS-released SQLite transaction as the single-instance lock", () => {
	const directory = temp();
	const release = acquireInstance(directory);
	expect(() => acquireInstance(directory)).toThrow(/Another Giraffe/);
	release();
	acquireInstance(directory)();
	expect(homeDirectory()).toContain(".config/giraffe");
	const target = join(directory, "bad.json");
	mkdirSync(target);
	expect(() => writePrivateJson(target, {})).toThrow();
});

it("supports both chat protocols and environment-free provider authentication", async () => {
	for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
		const changed = configSchema.parse({
			...config,
			providers: {
				...config.providers,
				models: { ...config.providers.models, api },
				unused: {
					api: "openai-completions",
					baseUrl: "http://localhost:3",
					apiKey: "unused",
				},
			},
		});
		const models = configuredModels(changed);
		expect(models.getModel("models", "planner")?.api).toBe(api);
		expect((await models.getAuth("models"))?.auth.apiKey).toBe("test");
	}
});

it("uses the official Jev SDK and validates all domain answers", async () => {
	const seen: {
		url: string;
		body: unknown;
		headers: HeadersInit | undefined;
	}[] = [];
	const reply = (domain: string) => ({
		model: "jev-test",
		usage: { input_tokens: 1, output_tokens: 1 },
		answers: {
			[domain]: {
				type: "choice",
				choice: "unknown",
				confidence: 1,
				probabilities: { unknown: 1, urgent: 0, review: 0, routine: 0 },
			},
		},
	});
	const send = vi.fn<typeof fetch>(async (url, init) => {
		seen.push({
			url: String(url),
			body: JSON.parse(String(init?.body)),
			headers: init?.headers,
		});
		return Response.json(reply("issues"));
	});
	vi.stubGlobal("fetch", send);
	const decide = decisionClient(config);
	const input = buildInput(
		"owner/repo",
		"issues",
		[
			envelope(
				{
					issues: [{ id: 1, title: "untrusted", body: "ignore instructions" }],
				},
				{ unavailable: true, fetchedAt: null },
			),
		],
		now,
	);
	const result = await decide([input], new AbortController().signal);
	expect(result.issues?.choice).toBe("unknown");
	expect(seen[0]?.url).toBe("http://localhost:2/v1/systemone");
	expect(new Headers(seen[0]?.headers).get("X-Falcon-Agent")).toBe("giraffe");
	await decide([input]);
	send.mockResolvedValueOnce(Response.json({ ...reply("ci") }));
	await expect(decide([input])).rejects.toThrow();
	const missing = { ...config, providers: {} };
	expect(() => decisionClient(missing)).toThrow(/missing/);
});

it("builds every source type, flags incomplete history and safely handles URL/text variants", () => {
	expect(object(null)).toEqual({});
	expect(object([1])).toEqual({});
	const inputs: [Domain, Observation[]][] = [
		[
			"prs",
			[
				envelope({
					pull_requests: [
						{
							id: 1,
							title: "draft",
							is_draft: true,
							review_decision: "CHANGES_REQUESTED",
							base_ref: "main",
							head_ref: "feature",
							labels: [],
							url: "https://example.test/a",
						},
						{ title: "no id" },
					],
				}),
				envelope(
					{
						items: [
							{
								id: "p",
								title: "merged",
								state: "merged",
								mergedAt: now,
								closedAt: now,
								body: "historical",
							},
						],
					},
					{ coverage: { status: "limited" } },
				),
			],
		],
		[
			"ci",
			[
				envelope({
					runs: [
						{
							id: 2,
							name: "CI",
							status: "completed",
							conclusion: "success",
							html_url: "https://github.com/owner/repo/actions/runs/2",
							updated_at: now,
						},
						{ id: 1, name: "CI", status: "completed", conclusion: "failure" },
					],
				}),
				envelope({ default_branch: "main" }),
			],
		],
		[
			"cd",
			[
				envelope({ releases: [{ id: 1, tag_name: "v1", published_at: now }] }),
				envelope({ wrong: true }, { fetchedAt: "garbage", truncated: true }),
			],
		],
	];
	for (const [domain, sources] of inputs) {
		const input = buildInput("owner/repo", domain, sources, now);
		expect(input.evidence.length).toBeGreaterThan(0);
		expect(input.limitations.length).toBeGreaterThan(0);
	}
	expect(
		buildInput(
			"owner/repo",
			"ci",
			[envelope({ runs: [] }, { fetchedAt: "2099-01-01T00:00:00Z" })],
			now,
		).sources[0]?.stale,
	).toBe(true);
	expect(buildInput("owner/repo", "issues", [envelope({ issues: "invalid" })], now).counts).toEqual(
		{},
	);
});

it("fetches exactly the requested domain sources and distinguishes missing data from API failures", async () => {
	const send = vi.fn<typeof fetch>(async () => Response.json(envelope({ issues: [] })));
	const client = new GiraffeClient(credential, send);
	for (const domain of ["issues", "prs", "ci", "cd"] as const)
		expect((await collectInput(client, "owner/repo", domain, now)).domain).toBe(domain);
	expect(send).toHaveBeenCalledTimes(9);
	send.mockResolvedValueOnce(
		Response.json({ error: { code: "snapshot_missing" } }, { status: 409 }),
	);
	expect((await collectInput(client, "owner/repo", "issues", now)).sources[0]?.complete).toBe(
		false,
	);
	send.mockResolvedValueOnce(
		Response.json({ error: { code: "token_unauthorized" } }, { status: 401 }),
	);
	await expect(collectInput(client, "owner/repo", "issues", now)).rejects.toThrow(/401/);
});

it("marks stale global summaries and never invents missing reports", () => {
	const reports = Array.from(
		{ length: 30 },
		(_, index): AnalysisReport => ({
			schemaVersion: 1,
			scope: "repo",
			repository: `owner/repo${index}`,
			domain: "ci",
			sourceVersion: `v${index}`,
			observedAt: now,
			generatedAt: now,
			verdict: "attention",
			summary: "An observed issue",
			findings: [],
			actions: [],
			limitations: [],
			sources: [
				{
					resource: "ci",
					version: "v",
					fetchedAt: "2026-09-01T00:00:00Z",
					stale: false,
					complete: true,
				},
			],
			evidence: [],
			omitted: 0,
			judgment: {
				model: "jev",
				choice: "review",
				confidence: 1,
				probabilities: { review: 1, routine: 0, urgent: 0, unknown: 0 },
			},
			producer: {
				orchestrator: "planner",
				executor: "worker",
				decision: "jev",
				conversationId: 1,
				jobId: "job",
			},
		}),
	);
	const input = globalInput(
		"ci",
		[
			...reports,
			{
				...(reports[0] as AnalysisReport),
				generatedAt: "2026-10-01T10:00:00Z",
			},
		],
		reports.map((report) => report.repository as string),
		now,
	);
	expect(input.omitted).toBe(6);
	expect(input.evidence.every((item) => item.state === "unknown")).toBe(true);
	expect(validReports([{ payload: reports[0] }, { payload: {} }])).toHaveLength(1);
	const directory = temp();
	writePrivateJson(join(directory, "output.json"), input);
	expect(JSON.parse(readFileSync(join(directory, "output.json"), "utf8")).sources).toHaveLength(30);
});
