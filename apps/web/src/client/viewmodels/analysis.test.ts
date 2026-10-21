import { expect, it } from "vitest";
import type { AnalysisReport, Resource } from "../../lib/analysis-contracts";
import { type AnalysisData, analysisState, safeEvidenceUrl, sourceQuality } from "./analysis";

const at = "2026-10-02T08:00:00Z";

it("falls back to the full version when the saved source predates content metadata", () => {
	const legacy = data.sources.map((source) => ({ ...source, contentVersion: null }));
	const hashed = {
		...report,
		sources: report.sources.map((source) => ({
			...source,
			contentVersion: `sha256:${"a".repeat(64)}`,
		})),
	};
	expect(sourceQuality(hashed, legacy, Date.parse(at)).current).toBe(true);
	expect(
		sourceQuality(
			hashed,
			legacy.map((source) => ({ ...source, version: "different" })),
			Date.parse(at),
		).current,
	).toBe(false);
});

it("keeps unchanged content current using the latest confirmation time, not report age", () => {
	const contentVersion = `sha256:${"a".repeat(64)}`;
	const now = Date.parse(at) + 72 * 3600000;
	const refreshedAt = new Date(now).toISOString();
	const original = data.sources[0];
	if (!original) throw new Error("missing source fixture");
	const saved = { ...original, version: "v2", contentVersion, fetchedAt: refreshedAt };
	const confirmed = {
		...report,
		sources: report.sources.map((source) => ({ ...source, contentVersion })),
	};
	for (const candidate of [
		confirmed,
		{
			...confirmed,
			scope: "global" as const,
			repository: null,
			sources: confirmed.sources.map((s) => ({ ...s, resource: "account:prs" })),
		},
	]) {
		const resource = candidate.sources[0]?.resource;
		if (!resource) throw new Error("missing report source fixture");
		const current = { ...saved, resource };
		const sources = [current];
		expect(sourceQuality(candidate, sources, now)).toMatchObject({
			current: true,
			complete: true,
			stale: false,
			oldestAt: refreshedAt,
		});
		expect(sourceQuality(candidate, sources, now + 36 * 3600000).stale).toBe(false);
		expect(sourceQuality(candidate, sources, now + 36 * 3600000 + 1).stale).toBe(true);
		for (const changed of [`sha256:${"b".repeat(64)}`])
			expect(
				sourceQuality(candidate, [{ ...current, contentVersion: changed, version: "v1" }], now)
					.current,
			).toBe(false);
		expect(sourceQuality(candidate, [], now)).toMatchObject({
			current: false,
			complete: false,
			stale: true,
		});
		for (const fetchedAt of [null, "invalid", new Date(now + 60001).toISOString()])
			expect(sourceQuality(candidate, [{ ...current, fetchedAt }], now).stale).toBe(true);
	}
	expect(sourceQuality(report, [{ ...saved, version: "v1" }], now)).toMatchObject({
		current: true,
		stale: false,
		oldestAt: refreshedAt,
	});
	expect(sourceQuality(report, [saved], now).current).toBe(false);
	expect(
		analysisState(
			{ ...data, reports: [row(confirmed)], sources: [saved] },
			"nocoo/app",
			now,
		).cards.find((card) => card.domain === "prs")?.verdict,
	).toBe("pass");
});
it("renders external reports without local decision metadata", () => {
	const { producer: _producer, ...external } = report;
	const state = analysisState(
		{
			...data,
			reports: [row({ ...external, judgment: { model: "grok-bot", choice: "routine" } })],
		},
		"nocoo/app",
		Date.parse(at),
	);
	expect(state.errors).toEqual([]);
	expect(state.cards.find((card) => card.domain === "prs")?.report?.judgment).toEqual({
		model: "grok-bot",
		choice: "routine",
	});
});
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
it("allows only safe evidence links", () => {
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
		},
		null,
		Date.parse(at),
	);
	expect(state.errors).toHaveLength(0);
	expect(state.lastRun).toBeNull();
});

const botRun = (payload: Resource["payload"] = {}): Resource => ({
	...row({ lastRunAt: at, status: "completed", analyzed: 4, skipped: 2, ...payload }),
	id: "grok-bot-run",
	type: "grok-bot-run",
	repository: null,
});
it.each(["running", "completed", "failed"])(
	"reads the bot's %s run without heartbeat semantics",
	(status) => {
		const state = analysisState(
			{ ...data, records: [{ ...botRun({ status, error: "provider_unavailable" }), status }] },
			null,
			Date.parse(at) + 45001,
		);
		expect(state.errors).toEqual([]);
		expect(state.lastRun).toEqual({
			lastRunAt: at,
			status,
			analyzed: 4,
			skipped: 2,
			error: "provider_unavailable",
			stale: false,
		});
	},
);
it.each([
	[-60000, false],
	[0, false],
	[48 * 3600000, false],
	[48 * 3600000 + 1, true],
])("ages daily bot runs at the 48-hour boundary (%i ms)", (age, stale) => {
	expect(
		analysisState({ ...data, records: [botRun()] }, null, Date.parse(at) + age).lastRun,
	).toMatchObject({ stale });
});
it.each([
	{ lastRunAt: null },
	{ lastRunAt: "invalid" },
	{ lastRunAt: "2026-10-02" },
	{ lastRunAt: "2026-10-02T08:01:00.001Z" },
	{ status: "unknown" },
	{ analyzed: -1 },
	{ analyzed: 0.5 },
	{ skipped: -1 },
	{ skipped: 0.5 },
	{ error: 1 },
])("rejects invalid bot payload %j", (payload) => {
	const state = analysisState({ ...data, records: [botRun(payload)] }, null, Date.parse(at));
	expect(state.lastRun).toBeNull();
	expect(state.errors).toEqual(["分析运行记录格式或状态无效"]);
});
it("requires matching row status and account-wide bot identity, ignoring legacy records", () => {
	for (const record of [
		{ ...botRun(), status: "failed" },
		{ ...botRun(), repository: "nocoo/app" },
	]) {
		const state = analysisState({ ...data, records: [record] }, null, Date.parse(at));
		expect(state.lastRun).toBeNull();
		expect(state.errors).toHaveLength(1);
	}
	const state = analysisState(
		{
			...data,
			records: [
				{ ...botRun(), type: "work-cron" },
				{ ...botRun(), type: "work-run" },
				{ ...botRun(), id: "other-bot" },
				botRun({ analyzed: 0, skipped: 0 }),
			],
		},
		null,
		Date.parse(at),
	);
	expect(state.errors).toEqual([]);
	expect(state.lastRun).toMatchObject({ analyzed: 0, skipped: 0, stale: false });
	expect(analysisState(data, null, Date.parse(at)).lastRun).toBeNull();
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
