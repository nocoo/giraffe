import type { CiReportResponse } from "../../lib/ci-health";
import { loadKind } from "./snapshot";

export type CiStream = CiReportResponse["streams"][number];
export type CiRepo = CiReportResponse["repos"][number];
export type CiFilters = { verdict: string; repo: string; query: string };

export const loadCi = () => loadKind<CiReportResponse>("ci");

/** Act now: consecutive failures. Watch: failures that recovered. Bot jobs are reported apart. */
export function ciBuckets(streams: CiStream[]) {
	const project = streams.filter((s) => s.scope !== "bot");
	return {
		act: project.filter((s) => s.verdict === "broken"),
		watch: project.filter((s) => s.verdict === "flaky"),
		stable: project.filter((s) => s.verdict === "healthy"),
		idle: project.filter((s) => s.verdict === "idle").length,
		bot: streams.filter((s) => s.scope === "bot"),
	};
}

export function ciFilterStreams(streams: CiStream[], f: CiFilters): CiStream[] {
	const q = f.query.trim().toLowerCase();
	return streams.filter(
		(s) =>
			(!f.verdict || (f.verdict === "recurring" ? s.recurring : s.verdict === f.verdict)) &&
			(!f.repo || s.repo === f.repo) &&
			(!q || `${s.repo} ${s.workflow} ${s.branch}`.toLowerCase().includes(q)),
	);
}

const PIPELINE_RANK: Record<string, number> = { broken: 0, flaky: 1, healthy: 2, idle: 3, none: 4 };
/** A release older than three typical gaps (or 90 days without a cadence) is stale. */
export function releaseRows(repos: CiRepo[]) {
	return repos
		.filter((r) => r.release?.latest)
		.map((r) => {
			const rel = r.release as NonNullable<CiRepo["release"]>;
			const limit = rel.cadenceDays ? Math.max(30, rel.cadenceDays * 3) : 90;
			return { repo: r.repo, ...rel, stale: (rel.ageDays ?? 0) > limit };
		})
		.sort(
			(a, b) =>
				(PIPELINE_RANK[a.pipeline] ?? 9) - (PIPELINE_RANK[b.pipeline] ?? 9) ||
				Number(b.stale) - Number(a.stale) ||
				(b.ageDays ?? 0) - (a.ageDays ?? 0) ||
				a.repo.localeCompare(b.repo),
		)
		.concat(
			repos
				.filter((r) => r.release && !r.release.latest)
				.map((r) => ({
					repo: r.repo,
					...(r.release as NonNullable<CiRepo["release"]>),
					stale: false,
				})),
		);
}

const OUTCOME_LABEL = {
	success: "成功",
	failure: "失败",
	other: "取消 / 跳过",
	pending: "进行中",
} as const;
/** Runs arrive newest first; timelines read left to right, so the newest ends on the right. */
export function runTimeline(recent: CiStream["recent"]) {
	return [...recent].reverse().map((r, i, all) => {
		const latest = i === all.length - 1;
		return {
			...r,
			latest,
			label: `${r.at.slice(0, 16).replace("T", " ")} UTC · ${OUTCOME_LABEL[r.outcome]}${latest ? " · 最新" : ""}`,
		};
	});
}
export function runSummary(cells: ReturnType<typeof runTimeline>): string {
	if (!cells.length) return "没有运行记录";
	return `从旧到新：${cells.map((c) => `${OUTCOME_LABEL[c.outcome]}${c.latest ? "（最新）" : ""}`).join("、")}`;
}
