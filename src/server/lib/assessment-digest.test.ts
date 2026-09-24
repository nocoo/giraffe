import { expect, it } from "vitest";
import { digestRow } from "./assessment-digest";

const report = {
	schemaVersion: 1,
	summary: "s",
	overall: "urgent",
	security: { status: "urgent", summary: "s", evidenceIds: [] },
	pullRequests: { status: "healthy", summary: "s", evidenceIds: [] },
	issues: { status: "attention", summary: "s", evidenceIds: [] },
	delivery: { status: "unknown", summary: "s", evidenceIds: [], trend: "slowing" },
	actions: [
		{ priority: "later", title: "l", reason: "r", evidenceIds: [] },
		{ priority: "next", title: "n1", reason: "r", evidenceIds: [] },
		{ priority: "now", title: "a", reason: "r", evidenceIds: [] },
		{ priority: "next", title: "n2", reason: "r", evidenceIds: [] },
		{ priority: "now", title: "b", reason: "r", evidenceIds: [] },
	],
	limitations: [],
};
const judgment = {
	model: "jev",
	templateVersion: 2,
	judgments: [
		{ id: "a", choice: "routine", uncertain: false },
		{ id: "b", choice: "review", uncertain: true },
		{ id: "c", choice: "urgent", uncertain: false },
		...Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, choice: "review", uncertain: false })),
	],
};
const row = {
	repo: "o/r",
	stage: "complete" as const,
	source_version: "v2",
	judgment: JSON.stringify(judgment),
	report: JSON.stringify(report),
	report_version: "v2",
	report_at: "2026-09-20T00:00:00.000Z",
	error: null,
	current_version: "v2",
};

it("projects reports and Jev flags into bounded, urgency-first summaries", () => {
	const digest = digestRow(row);
	expect(digest).toMatchObject({
		repo: "o/r",
		current: true,
		overall: "urgent",
		sections: { security: "urgent", pullRequests: "healthy", issues: "attention" },
		trend: "slowing",
		error: null,
	});
	expect(digest.actions.map((a) => a.title)).toEqual(["a", "b", "n1"]);
	expect(digest.flags).toHaveLength(8);
	expect(digest.flags[0]).toEqual({ id: "c", choice: "urgent", uncertain: false });
});

it("marks superseded, missing and malformed reports without inventing conclusions", () => {
	expect(digestRow({ ...row, current_version: "v3" }).current).toBe(false);
	expect(digestRow({ ...row, current_version: null }).current).toBe(false);
	expect(
		digestRow({ ...row, stage: "failed", report: "{", judgment: null, error: "ai_timeout" }),
	).toMatchObject({
		current: false,
		overall: null,
		sections: null,
		trend: null,
		reportAt: null,
		actions: [],
		flags: [],
		error: "ai_timeout",
	});
	expect(digestRow({ ...row, stage: "judgment", error: "old" }).error).toBeNull();
});
