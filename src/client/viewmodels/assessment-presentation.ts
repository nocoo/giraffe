import type { Judgment, JudgmentPriority, RepositoryReport } from "../../lib/ai-review";
import type { RepoAssessment } from "../../lib/repo-assessment";
import type { CandyTone } from "../lib/format";

export const REPORT_STATUS: Record<
	RepositoryReport["overall"],
	{ label: string; tone: CandyTone }
> = {
	healthy: { label: "正常", tone: "green" },
	attention: { label: "需要关注", tone: "amber" },
	urgent: { label: "优先处理", tone: "red" },
	unknown: { label: "信息不足", tone: "gray" },
};

export const JUDGMENT_STATUS = {
	urgent: { label: "立即处理", tone: "red" },
	review: { label: "人工判断", tone: "amber" },
	routine: { label: "常规跟进", tone: "green" },
	unknown: { label: "信息不足", tone: "gray" },
} as const;

export const ACTION_PRIORITY = {
	now: { label: "立即", tone: "red" },
	next: { label: "接下来", tone: "amber" },
	later: { label: "后续", tone: "blue" },
} as const;

export const DELIVERY_TREND = {
	accelerating: "交付加快",
	steady: "节奏稳定",
	slowing: "交付放缓",
	inactive: "近期无交付",
	unknown: "节奏待确认",
} as const;

export const RUN_STATUS: Record<RepoAssessment["status"], string> = {
	unconfigured: "未配置 AI",
	missing: "尚未生成",
	judgment: "Jev 正在判断",
	summary: "正在生成报告",
	complete: "评估完成",
	failed: "本次评估失败",
};

type Heading = { title: string; category: "security" | "prs" | "issues" | "delivery" | "general" };
const QUESTION_HEADINGS: Record<string, Heading> = {
	security_urgency: { title: "安全风险", category: "security" },
	external_pr_review: { title: "外部 PR 审查", category: "prs" },
	unusual_pr_risk: { title: "非常规变更", category: "prs" },
	blocking_issues: { title: "阻塞性 Issue", category: "issues" },
	delivery_cadence: { title: "交付节奏", category: "delivery" },
	review_backlog: { title: "PR 审查积压", category: "prs" },
	delivery_reliability: { title: "交付可靠性", category: "delivery" },
	issue_flow: { title: "Issue 处理进展", category: "issues" },
};
const ITEM_HEADINGS = {
	alerts: { title: "安全告警", category: "security" },
	prs: { title: "PR 事项", category: "prs" },
	issues: { title: "Issue 事项", category: "issues" },
} as const;

export const percent = new Intl.NumberFormat("zh-CN", {
	style: "percent",
	maximumFractionDigits: 1,
});

export function judgmentHeading(judgment: Judgment): Heading {
	const heading = Object.hasOwn(QUESTION_HEADINGS, judgment.id)
		? QUESTION_HEADINGS[judgment.id]
		: undefined;
	if (heading) return heading;
	const item = /^item_(alerts|prs|issues)_(\d+)$/.exec(judgment.id);
	if (item) {
		const source = ITEM_HEADINGS[item[1] as keyof typeof ITEM_HEADINGS];
		return { title: `${source.title} ${Number(item[2]) + 1}`, category: source.category };
	}
	return { title: judgment.question, category: "general" };
}

export function judgmentDistribution(judgment: Judgment) {
	return (Object.keys(JUDGMENT_STATUS) as JudgmentPriority[]).map((choice) => ({
		choice,
		...JUDGMENT_STATUS[choice],
		value: judgment.probabilities[choice] * 100,
		label: percent.format(judgment.probabilities[choice]),
	}));
}

export function judgmentOverview(judgments: Judgment[]) {
	const counts = { urgent: 0, review: 0, routine: 0, unknown: 0, uncertain: 0 };
	for (const judgment of judgments) {
		counts[judgment.choice] += 1;
		if (judgment.uncertain) counts.uncertain += 1;
	}
	return counts;
}
