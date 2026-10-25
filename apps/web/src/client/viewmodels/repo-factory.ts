import type { FactoryEvent, FactoryStreamName } from "../../lib/factory-types";
import type { CandyTone } from "../lib/format";

const RECORD_STATUS: Record<string, { label: string; tone: CandyTone }> = {
	merged: { label: "已合并", tone: "purple" },
	open: { label: "开放", tone: "green" },
	closed: { label: "已关闭", tone: "gray" },
	published: { label: "已发布", tone: "green" },
	fixed: { label: "已修复", tone: "teal" },
	dismissed: { label: "已忽略", tone: "gray" },
	declared: { label: "已声明", tone: "gray" },
	committed: { label: "已提交", tone: "gray" },
};

/** Record states are GitHub's own vocabulary; unknown values stay visible, not blank. */
export function recordStatus(state: string): { label: string; tone: CandyTone } {
	return RECORD_STATUS[state] ?? { label: state, tone: "gray" };
}

const STATE_OPTIONS: Partial<Record<FactoryStreamName, { value: string; label: string }[]>> = {
	issues: [
		{ value: "open", label: "Open" },
		{ value: "closed", label: "Closed" },
	],
	prs: [
		{ value: "open", label: "Open" },
		{ value: "merged", label: "Merged" },
		{ value: "closed", label: "Closed" },
	],
	actions: [
		{ value: "success", label: "成功" },
		{ value: "failure", label: "失败" },
		{ value: "cancelled", label: "取消" },
	],
	releases: [{ value: "published", label: "已发布" }],
	alerts: [
		{ value: "open", label: "Open" },
		{ value: "fixed", label: "Fixed" },
		{ value: "dismissed", label: "Dismissed" },
	],
};

/** Streams without a meaningful status (commits, dependency evidence) get no filter. */
export function recordStateOptions(stream: FactoryStreamName) {
	return [{ value: "", label: "全部状态" }, ...(STATE_OPTIONS[stream] ?? [])];
}

export function isRecordNumbered(stream: FactoryStreamName): boolean {
	return stream === "prs" || stream === "issues";
}

export function recordNumber(event: Pick<FactoryEvent, "url">): string {
	const match = /\/(?:pull|issues)\/(\d+)(?:\/|$)/.exec(event.url);
	return match?.[1] ? `#${match[1]}` : "";
}

const ISSUE_REASONS: Record<string, string> = {
	completed: "完成",
	not_planned: "未计划",
	reopened: "重新打开",
};

export function issueReason(reason: string | null | undefined): string {
	return reason ? (ISSUE_REASONS[reason] ?? reason) : "";
}

const CHECKS: Record<string, { label: string; tone: CandyTone }> = {
	SUCCESS: { label: "检查通过", tone: "green" },
	FAILURE: { label: "检查失败", tone: "red" },
	ERROR: { label: "检查出错", tone: "red" },
	PENDING: { label: "检查中", tone: "amber" },
	EXPECTED: { label: "等待检查", tone: "gray" },
};

export function checksStatus(
	state: string | null | undefined,
): { label: string; tone: CandyTone } | null {
	return state ? (CHECKS[state] ?? { label: state, tone: "gray" }) : null;
}

/** CI runs report whole seconds; keep sub-minute precision instead of rounding to zero. */
export function runDuration(event: Pick<FactoryEvent, "activityRun">): string {
	const seconds = event.activityRun?.duration_s;
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}
