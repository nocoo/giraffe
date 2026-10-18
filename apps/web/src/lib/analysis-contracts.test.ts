import { expect, it } from "vitest";
import { analysisReportSchema, judgmentSchema } from "./analysis-contracts";

it("accepts external judgments without invented probabilities", () => {
	expect(judgmentSchema.parse({ model: "grok-bot", choice: "review" })).toEqual({
		model: "grok-bot",
		choice: "review",
	});
	const probabilities = { routine: 0.1, review: 0.7, urgent: 0.1, unknown: 0.1 };
	expect(
		judgmentSchema.safeParse({
			model: "grok-bot",
			choice: "review",
			confidence: 0.7,
			probabilities,
		}).success,
	).toBe(true);
	expect(
		judgmentSchema.safeParse({ model: "grok-bot", choice: "urgent", probabilities }).success,
	).toBe(false);
	expect(
		judgmentSchema.safeParse({
			model: "grok-bot",
			choice: "review",
			probabilities: { ...probabilities, review: 0.8 },
		}).success,
	).toBe(false);
	expect(
		judgmentSchema.safeParse({ model: "grok-bot", choice: "review", confidence: 2 }).success,
	).toBe(false);
});

it("keeps provenance mandatory without requiring local runtime metadata", () => {
	const report = {
		schemaVersion: 1,
		scope: "repo",
		repository: "nocoo/app",
		domain: "issues",
		verdict: "unknown",
		summary: "Saved evidence is incomplete",
		findings: [],
		actions: [],
		limitations: ["Missing source"],
		sourceVersion: "0123456789abcdef",
		observedAt: "2026-10-19T00:00:00Z",
		generatedAt: "2026-10-19T00:00:00Z",
		sources: [],
		evidence: [],
		omitted: 0,
		judgment: { model: "grok-bot", choice: "unknown" },
	};
	expect(analysisReportSchema.parse(report)).toEqual(report);
	expect(
		analysisReportSchema.safeParse({ ...report, producer: { executor: "grok" } }).success,
	).toBe(true);
	expect(analysisReportSchema.safeParse({ ...report, sourceVersion: undefined }).success).toBe(
		false,
	);
	expect(analysisReportSchema.safeParse({ ...report, verdict: "success" }).success).toBe(false);
});
