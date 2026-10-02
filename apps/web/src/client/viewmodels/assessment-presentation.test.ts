import { describe, expect, it } from "vitest";
import type { Judgment } from "../../lib/ai-review";
import { judgmentDistribution, judgmentHeading, judgmentOverview } from "./assessment-presentation";

const judgment: Judgment = {
	id: "security_urgency",
	question: "Does the evidence warrant intervention?",
	evidenceIds: ["issues:12"],
	choice: "review",
	confidence: 0.5,
	probabilities: { routine: 0.4, urgent: 0.05, unknown: 0.05, review: 0.5 },
	uncertain: true,
};

describe("assessment presentation", () => {
	it("gives the canonical questions readable Chinese headings without rewriting evidence", () => {
		const headings = {
			security_urgency: "安全风险",
			external_pr_review: "外部 PR 审查",
			unusual_pr_risk: "非常规变更",
			blocking_issues: "阻塞性 Issue",
			delivery_cadence: "交付节奏",
			review_backlog: "PR 审查积压",
			delivery_reliability: "交付可靠性",
			issue_flow: "Issue 处理进展",
		};
		for (const [id, title] of Object.entries(headings)) {
			expect(judgmentHeading({ ...judgment, id }).title).toBe(title);
		}
		expect(judgmentHeading({ ...judgment, id: "item_issues_0" })).toMatchObject({
			title: "Issue 事项 1",
			category: "issues",
		});
		expect(judgmentHeading({ ...judgment, id: "item_prs_3" }).title).toBe("PR 事项 4");
		expect(judgmentHeading({ ...judgment, id: "item_alerts_2" }).title).toBe("安全告警 3");
		expect(judgmentHeading({ ...judgment, id: "custom" }).title).toBe(judgment.question);
		expect(judgment.question).toBe("Does the evidence warrant intervention?");
	});

	it("keeps probability magnitudes and a stable priority order, including zero and one", () => {
		expect(
			judgmentDistribution(judgment).map(({ choice, value, label }) => ({ choice, value, label })),
		).toEqual([
			{ choice: "urgent", value: 5, label: "5%" },
			{ choice: "review", value: 50, label: "50%" },
			{ choice: "routine", value: 40, label: "40%" },
			{ choice: "unknown", value: 5, label: "5%" },
		]);
		expect(
			judgmentDistribution({
				...judgment,
				probabilities: { urgent: 1, review: 0, routine: 0, unknown: 0 },
			}).map((item) => item.value),
		).toEqual([100, 0, 0, 0]);
	});

	it("counts review flags separately from the selected intervention priority", () => {
		const rows = [
			judgment,
			{ ...judgment, choice: "urgent" as const, uncertain: false },
			{ ...judgment, choice: "unknown" as const },
		];
		expect(judgmentOverview(rows)).toEqual({
			urgent: 1,
			review: 1,
			routine: 0,
			unknown: 1,
			uncertain: 2,
		});
		expect(judgmentOverview([])).toEqual({
			urgent: 0,
			review: 0,
			routine: 0,
			unknown: 0,
			uncertain: 0,
		});
	});
});
