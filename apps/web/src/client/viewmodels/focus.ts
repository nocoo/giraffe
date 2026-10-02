import type { CiRepo, CiStream } from "./ci";
import { loadCi } from "./ci";
import type { InsightRow } from "./insights";
import type { IssueRow } from "./issues";
import type { PullRow } from "./pulls";
import { getRepositoryScope } from "./scope";

export type FocusCategory = "security" | "delivery" | "review" | "issues" | "activity";
export type FocusReason = { category: FocusCategory; weight: number; text: string };
export type FocusRepo = {
	repo: string;
	score: number;
	level: "urgent" | "attention" | "watch";
	primary: FocusCategory;
	reasons: FocusReason[];
	issues: number;
	pulls: number;
	days: number;
};
export type FocusSources = {
	rows: InsightRow[];
	issues: IssueRow[] | null;
	pulls: PullRow[] | null;
	ci: { repos: CiRepo[]; streams: CiStream[] } | null;
	fetchedAt: string;
};

export const FOCUS_LIMIT = 10;
const DAY = 86_400_000;
const SECURITY_LABEL = /secur|vuln|cve|漏洞|安全/i;
const DEPENDENCY_LABEL = /^dep|dependenc|依赖/i;
const BOT = /\[bot\]$|^dependabot|^renovate/i;

export const FOCUS_CATEGORY: Record<FocusCategory, string> = {
	security: "安全",
	delivery: "交付",
	review: "审查",
	issues: "Issue",
	activity: "活跃度",
};

const ageDays = (now: number, at: string) => Math.max(0, Math.floor((now - Date.parse(at)) / DAY));
const ownerOf = (repo: string) => repo.slice(0, repo.indexOf("/")).toLowerCase();
const key = (repo: string) => repo.toLowerCase();

function group<T>(rows: T[] | null, repo: (row: T) => string): Map<string, T[]> {
	const map = new Map<string, T[]>();
	for (const row of rows ?? []) {
		const k = key(repo(row));
		map.set(k, [...(map.get(k) ?? []), row]);
	}
	return map;
}

function ciReasons(repo: CiRepo | undefined, streams: CiStream[]): FocusReason[] {
	if (!repo) return [];
	const broken = streams.filter((s) => s.verdict === "broken" && s.scope === "main");
	const recurring = streams.filter((s) => s.recurring);
	const out: FocusReason[] = [];
	for (const s of broken.slice(0, 2))
		out.push({
			category: "delivery",
			weight: 22 + Math.min(s.streak, 6) * 2,
			text: `${s.workflow} ${s.reason}`,
		});
	if (!broken.length && recurring.length)
		out.push({
			category: "delivery",
			weight: 8,
			text: `${recurring[0]?.workflow ?? "CI"} 反复失败（${recurring.length} 条工作流）`,
		});
	if (repo.release?.pipeline === "broken")
		out.push({
			category: "delivery",
			weight: 6,
			text: repo.release.latest
				? `发布流水线失败，最新版本 ${repo.release.latest}`
				: "发布流水线失败，尚无成功发布",
		});
	return out;
}

function workReasons(
	row: InsightRow,
	issues: IssueRow[],
	pulls: PullRow[],
	now: number,
): FocusReason[] {
	const out: FocusReason[] = [];
	const high = row.alerts.filter((a) => a.severity === "critical" || a.severity === "high");
	if (high.length)
		out.push({
			category: "security",
			weight: 20 + Math.min(high.length - 1, 4) * 5,
			text: `${high.length} 个高危/严重安全告警`,
		});
	else if (row.alerts.length)
		out.push({ category: "security", weight: 6, text: `${row.alerts.length} 个安全告警` });
	const security = issues.filter((i) => i.labels.some((l) => SECURITY_LABEL.test(l.name)));
	if (security.length)
		out.push({
			category: "security",
			weight: 15,
			text: `${security.length} 个安全相关 Issue 未关闭`,
		});
	const staleIssues = issues.filter((i) => ageDays(now, i.created_at) > 30).length;
	if (staleIssues)
		out.push({
			category: "issues",
			weight: Math.min(staleIssues, 10),
			text: `${staleIssues} 个 Issue 超过 30 天未关闭`,
		});
	if (row.open_issue_count >= 20)
		out.push({ category: "issues", weight: 8, text: `${row.open_issue_count} 个 open Issue 积压` });
	const owner = ownerOf(row.name_with_owner);
	const external = pulls.filter(
		(p) => p.author_login && !BOT.test(p.author_login) && p.author_login.toLowerCase() !== owner,
	);
	if (external.length)
		out.push({
			category: "review",
			weight: 8 + (external.length - 1) * 2,
			text: `${external.length} 个外部贡献者 PR 等待处理`,
		});
	const blocked = pulls.filter(
		(p) =>
			!p.is_draft &&
			(p.review_decision === "CHANGES_REQUESTED" || p.review_decision === "REVIEW_REQUIRED"),
	).length;
	if (blocked)
		out.push({
			category: "review",
			weight: 3 * Math.min(blocked, 4),
			text: `${blocked} 个 PR 待审查或需修改`,
		});
	const stalePulls = pulls.filter((p) => ageDays(now, p.updated_at) > 14).length;
	if (stalePulls)
		out.push({ category: "review", weight: 4, text: `${stalePulls} 个 PR 超过 14 天无更新` });
	const pending = issues.length + pulls.length;
	if (row.days_since_push >= 90 && pending)
		out.push({
			category: "activity",
			weight: 10,
			text: `${row.days_since_push >= 9999 ? "从未" : `${row.days_since_push} 天未`}推送，仍有 ${pending} 项待办`,
		});
	else if (row.days_since_push >= 180)
		out.push({
			category: "activity",
			weight: 2,
			text: `${row.days_since_push >= 9999 ? "没有推送记录" : `${row.days_since_push} 天未推送`}`,
		});
	return out;
}

function levelOf(score: number, reasons: FocusReason[]): FocusRepo["level"] {
	if (score >= 40 || reasons.some((r) => r.weight >= 20)) return "urgent";
	return score >= 15 ? "attention" : "watch";
}

/** Ranks participating repositories by weighted evidence; every point carries a readable reason. */
export function focusRanking(src: FocusSources, limit = FOCUS_LIMIT): FocusRepo[] {
	const now = Date.parse(src.fetchedAt);
	const issues = group(src.issues, (r) => r.name_with_owner);
	const pulls = group(src.pulls, (r) => r.name_with_owner);
	const ciRepos = new Map((src.ci?.repos ?? []).map((r) => [key(r.repo), r]));
	const streams = group(
		(src.ci?.streams ?? []).filter((s) => s.scope !== "bot"),
		(s) => s.repo,
	);
	const ranked: FocusRepo[] = [];
	for (const row of src.rows) {
		const k = key(row.name_with_owner);
		const repoIssues = issues.get(k) ?? [];
		const repoPulls = pulls.get(k) ?? [];
		const reasons = [
			...ciReasons(ciRepos.get(k), streams.get(k) ?? []),
			...workReasons(row, repoIssues, repoPulls, now),
		].sort((a, b) => b.weight - a.weight);
		const score = Math.round(reasons.reduce((n, r) => n + r.weight, 0));
		if (score <= 0) continue;
		const byCategory = new Map<FocusCategory, number>();
		for (const r of reasons)
			byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + r.weight);
		const domains = [...byCategory].sort((a, b) => b[1] - a[1]);
		const primary = domains[0]?.[0] ?? "activity";
		ranked.push({
			repo: row.name_with_owner,
			score,
			level: levelOf(score, reasons),
			primary,
			reasons,
			issues: src.issues ? repoIssues.length : row.open_issue_count,
			pulls: repoPulls.length,
			days: row.days_since_push,
		});
	}
	return ranked.sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo)).slice(0, limit);
}

export type Finding = { tone: "red" | "amber" | "blue" | "gray"; text: string };

/** Account-wide observations that no single chart states directly. */
export function focusFindings(src: FocusSources): Finding[] {
	const now = Date.parse(src.fetchedAt);
	const out: Finding[] = [];
	const repos = src.rows.length;
	const broken = new Set(
		(src.ci?.streams ?? [])
			.filter((s) => s.verdict === "broken" && s.scope === "main")
			.map((s) => s.repo),
	);
	if (broken.size)
		out.push({ tone: "red", text: `${broken.size} 个仓库默认分支 CI 持续失败，交付被阻塞` });
	const high = src.rows.filter((r) =>
		r.alerts.some((a) => a.severity === "critical" || a.severity === "high"),
	);
	if (high.length) out.push({ tone: "red", text: `${high.length} 个仓库存在高危或严重安全告警` });
	if (src.issues?.length) {
		const deps = src.issues.filter((i) => i.labels.some((l) => DEPENDENCY_LABEL.test(l.name)));
		const share = deps.length / src.issues.length;
		if (deps.length && share >= 0.3) {
			const across = new Set(deps.map((i) => i.name_with_owner)).size;
			out.push({
				tone: "amber",
				text: `${Math.round(share * 100)}% 的 open Issue（${deps.length} 个）是依赖更新，分布在 ${across} 个仓库，适合批量合并处理`,
			});
		}
		const week = src.issues.filter((i) => ageDays(now, i.created_at) < 7).length;
		const prev = src.issues.filter((i) => {
			const d = ageDays(now, i.created_at);
			return d >= 7 && d < 14;
		}).length;
		if (week > prev * 2 && week >= 10)
			out.push({
				tone: "amber",
				text: `本周新增 ${week} 个仍未关闭的 Issue，上周为 ${prev} 个，积压在加速`,
			});
		const counts = [...group(src.issues, (i) => i.name_with_owner).values()]
			.map((l) => l.length)
			.sort((a, b) => b - a);
		const top3 = counts.slice(0, 3).reduce((n, c) => n + c, 0);
		if (counts.length > 5 && top3 / src.issues.length >= 0.5)
			out.push({
				tone: "blue",
				text: `Issue 高度集中：前 3 个仓库占 ${Math.round((top3 / src.issues.length) * 100)}%`,
			});
	}
	if (src.pulls) {
		const external = src.pulls.filter(
			(p) =>
				p.author_login &&
				!BOT.test(p.author_login) &&
				p.author_login.toLowerCase() !== ownerOf(p.name_with_owner),
		);
		if (external.length)
			out.push({
				tone: "amber",
				text: `${external.length} 个外部贡献者 PR 等待回复，及时审查有助于留住贡献者`,
			});
	}
	const quiet = src.rows.filter((r) => r.days_since_push >= 90).length;
	if (repos && quiet / repos >= 0.2)
		out.push({
			tone: "gray",
			text: `${quiet} 个参与统计的仓库超过 90 天未推送，可考虑归档或排除出统计`,
		});

	return out;
}

async function optional<T>(load: () => Promise<T | { missing: true }>): Promise<T | null> {
	try {
		const value = await load();
		return value && typeof value === "object" && "missing" in value ? null : (value as T);
	} catch {
		return null;
	}
}

/** Saved deterministic CI facts stay independent of local Agent analysis. */
export async function loadFocusSources(scope = getRepositoryScope()) {
	return { ci: await optional(() => loadCi(scope)) };
}
