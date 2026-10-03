import type { AnalysisReport, Resource } from "@nocoo/giraffe-agent/contracts";
import { expect, it } from "vitest";
import {
	type AnalysisData,
	analysisState,
	runnerState,
	safeEvidenceUrl,
	sourceQuality,
} from "./analysis";

const at = "2026-10-02T08:00:00Z";
it("validates resident portfolio reports against direct account snapshots", () => {
	const global = {
		...report,
		scope: "global" as const,
		repository: null,
		sources: [
			{ resource: "account:prs", version: "v1", fetchedAt: at, complete: true, stale: false },
		],
	};
	const current = [
		{
			resource: "account:prs",
			version: "v1",
			fetchedAt: at,
			freshness: { missing: 0 },
			coverage: null,
			truncated: false,
			unavailable: false,
		},
	];
	expect(sourceQuality(global, current, Date.parse(at), [], ["nocoo/app"])).toMatchObject({
		current: true,
		complete: true,
		stale: false,
	});
	expect(
		sourceQuality(
			global,
			[{ ...current[0], resource: "account:prs", version: "v2" }] as never,
			Date.parse(at),
		).current,
	).toBe(false);
});
const report: AnalysisReport = {
	schemaVersion: 1,
	scope: "repo",
	repository: "nocoo/app",
	domain: "prs",
	verdict: "pass",
	summary: "Review complete",
	findings: [],
	actions: [],
	limitations: [],
	sources: [
		{ resource: "repo:nocoo/app:prs", version: "v1", fetchedAt: at, complete: true, stale: false },
	],
	evidence: [],
	sourceVersion: "composite",
	observedAt: at,
	generatedAt: at,
	omitted: 0,
	judgment: {
		model: "jev",
		choice: "routine",
		confidence: 0.8,
		probabilities: { routine: 0.8, review: 0.1, urgent: 0.05, unknown: 0.05 },
	},
	producer: {
		orchestrator: "planner",
		executor: "executor",
		decision: "jev",
		conversationId: 1,
		jobId: "job",
	},
};
const row = (payload: unknown, id = "r"): Resource => ({
	id,
	account_id: "a",
	repository: "nocoo/app",
	type: "github-analysis",
	status: "completed",
	source_version: "composite",
	payload: payload as Resource["payload"],
	revision: 1,
	created_at: at,
	updated_at: at,
});
const data: AnalysisData = {
	account_id: "a",
	repositories: ["nocoo/app"],
	reports: [row(report)],
	records: [],
	jobs: [],
	sources: [
		{
			resource: "repo:nocoo/app:prs",
			version: "v1",
			fetchedAt: at,
			truncated: false,
			unavailable: false,
			freshness: { missing: 0 },
		},
	],
};
it("matches raw source versions, never confuses generation with evidence freshness", () => {
	const now = Date.parse(at) + 1000;
	const state = analysisState(data, "nocoo/app", now);
	expect(state.cards.find((c) => c.domain === "prs")).toMatchObject({
		quality: { current: true, stale: false },
	});
	expect(
		sourceQuality(
			report,
			[{ ...(data.sources[0] as import("./analysis").CurrentSource), version: "v2" }],
			now,
		).current,
	).toBe(false);
	expect(
		sourceQuality(
			{ ...report, generatedAt: new Date(now + 40 * 3600000).toISOString() },
			data.sources,
			now + 40 * 3600000,
		).stale,
	).toBe(true);
	expect(sourceQuality({ ...report, sources: [] }, [], now).complete).toBe(false);
});
it("surfaces invalid reports and picks current source version before newer historical reports", () => {
	const stale = {
		...report,
		generatedAt: "2026-10-02T10:00:00Z",
		sources: [{ ...(report.sources[0] as AnalysisReport["sources"][number]), version: "old" }],
	};
	const state = analysisState(
		{ ...data, reports: [row(stale, "old"), row(report), row({ bad: true }, "bad")] },
		"nocoo/app",
		Date.parse(at),
	);
	expect(state.errors).toHaveLength(1);
	expect(state.cards.find((c) => c.domain === "prs")?.report?.sourceVersion).toBe("composite");
	expect(state.cards.find((c) => c.domain === "issues")?.report).toBeNull();
});
it("ages heartbeats and allows only safe evidence links", () => {
	const heartbeat = {
		schemaVersion: 1,
		lastSeenAt: at,
		state: "running",
		expression: "0 * * * *",
		timezone: "UTC",
		enabled: true,
		paused: false,
		nextRunAt: at,
		lastRunAt: null,
		activeOccurrence: "one",
		completed: 0,
		lastError: null,
		capability: "authorized-work",
		maxRounds: 20,
	};
	expect(runnerState(row(heartbeat), Date.parse(at) + 45001)?.online).toBe(false);
	expect(runnerState(row(heartbeat), Date.parse(at) + 45000)?.online).toBe(true);
	expect(runnerState(row({}), 0)).toBeNull();
	expect(safeEvidenceUrl("javascript:alert(1)")).toBeNull();
	expect(safeEvidenceUrl("https://github.com/nocoo/app")).toBeTruthy();
	expect(safeEvidenceUrl(null)).toBeNull();
});

it("matches global sources to the latest domain reports and recomputes missing/stale coverage", () => {
	const global: AnalysisReport = {
		...report,
		scope: "global",
		repository: null,
		sources: [
			{ resource: "nocoo/app", version: "composite", fetchedAt: at, complete: true, stale: false },
		],
	};
	expect(sourceQuality(global, data.sources, Date.parse(at), [report])).toMatchObject({
		current: true,
		complete: true,
		stale: false,
	});
	expect(sourceQuality(global, data.sources, Date.parse(at), [])).toMatchObject({
		current: false,
		complete: false,
	});
	expect(
		sourceQuality(
			{
				...report,
				sources: [{ resource: "x", version: null, fetchedAt: null, complete: false, stale: true }],
			},
			[],
			Date.parse(at),
		),
	).toMatchObject({ current: false, complete: false, stale: true });
	expect(
		sourceQuality(
			{
				...report,
				sources: [
					{ ...(report.sources[0] as AnalysisReport["sources"][number]), fetchedAt: "bad" },
				],
			},
			data.sources,
			0,
		).stale,
	).toBe(true);
	expect(sourceQuality(report, data.sources, Date.parse(at) - 120000).stale).toBe(true);
	expect(
		sourceQuality(
			report,
			[{ ...(data.sources[0] as import("./analysis").CurrentSource), truncated: true }],
			Date.parse(at),
		).complete,
	).toBe(false);
	expect(safeEvidenceUrl("bad")).toBeNull();
	expect(safeEvidenceUrl("https://user:pass@example.com")).toBeNull();
	const state = analysisState(
		{
			...data,
			records: [{ ...row({}), type: "work-cron" }],
			jobs: [
				{ ...row({}, "j"), type: "work-run" },
				{ ...row({}, "k"), type: "work-run" },
			],
		},
		null,
		Date.parse(at),
	);
	expect(state.errors).toHaveLength(1);
	expect(state.jobs).toHaveLength(2);
});

it("marks portfolio membership changes without comparing repository composite versions to raw resources", () => {
	const global: AnalysisReport = {
		...report,
		scope: "global",
		repository: null,
		sources: [
			{ resource: "nocoo/app", version: "composite", fetchedAt: at, complete: true, stale: false },
		],
	};
	expect(
		sourceQuality(global, data.sources, Date.parse(at), [report], ["nocoo/app", "nocoo/new"]),
	).toMatchObject({ current: false, complete: false });
	expect(sourceQuality(global, data.sources, Date.parse(at), [report], ["nocoo/app"]).current).toBe(
		true,
	);
});

it("never presents a green pass when evidence is stale, incomplete or from old versions", () => {
	for (const patch of [
		{ sources: [] },
		{ sources: [{ ...(data.sources[0] as import("./analysis").CurrentSource), version: "new" }] },
	]) {
		expect(
			analysisState({ ...data, ...patch }, "nocoo/app", Date.parse(at)).cards.find(
				(c) => c.domain === "prs",
			)?.verdict,
		).toBe("unknown");
	}
	expect(
		analysisState(data, "nocoo/app", Date.parse(at) + 40 * 3600000).cards.find(
			(c) => c.domain === "prs",
		)?.verdict,
	).toBe("unknown");
});

it("invalidates a global report after a newer retry even with the same evidence version", () => {
	const global: AnalysisReport = {
		...report,
		scope: "global",
		repository: null,
		sources: [
			{ resource: "nocoo/app", version: "composite", fetchedAt: at, complete: true, stale: false },
		],
	};
	expect(
		sourceQuality(
			global,
			data.sources,
			Date.parse(at),
			[{ ...report, generatedAt: "2026-10-02T09:00:00Z" }],
			["nocoo/app"],
		).current,
	).toBe(false);
});
