import type { FactoryDay } from "../../lib/factory-types";
import { participates } from "../../lib/repo-statistics";
import type { AlertItem } from "./alerts";
import type { DigestRepo } from "./digest";
import type { NotificationRow } from "./inbox";
import type { IssueRow } from "./issues";
import {
	type AgeBucket,
	ageBucket,
	ageBuckets,
	countBy,
	dailySeries,
	daysAgo,
	matchesFilters,
	shortRepo,
	weeklySeries,
} from "./overview";
import type { PullRow } from "./pulls";
import type { ActionRun, RepoRelease } from "./repo-detail";
import type { RepoRow } from "./repos";

function median(values: number[]): number | null {
	if (!values.length) return null;
	const s = [...values].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}
const ageOf = (at: string | null | undefined, now: string): AgeBucket | "" => {
	const d = daysAgo(at, now);
	return d === null ? "" : ageBucket(d);
};

type WorkRow = Pick<IssueRow, "name_with_owner" | "created_at" | "author_login"> &
	Partial<Pick<IssueRow, "labels" | "comments_count">>;
const labelsOf = (r: WorkRow) => (r.labels?.length ? r.labels.map((l) => l.name) : ["未标记"]);
export type WorkFilters = { repo: string; label: string; author: string; age: string };

/** Open work (Issues or PRs): age profile, where it sits and who opened it. */
export function workBoard<T extends WorkRow>(all: T[], now: string, filters: WorkFilters) {
	const rows = all.filter((r) =>
		matchesFilters(
			r,
			{
				repo: (x) => x.name_with_owner,
				label: labelsOf,
				author: (x) => x.author_login ?? "未知",
				age: (x) => ageOf(x.created_at, now),
			},
			filters,
		),
	);
	const ages = rows.map((r) => daysAgo(r.created_at, now)).filter((d): d is number => d !== null);
	return {
		rows,
		total: all.length,
		age: ageBuckets(
			rows.map((r) => r.created_at),
			now,
		),
		repos: countBy(rows, (r) => r.name_with_owner, 8),
		repoCount: new Set(rows.map((r) => r.name_with_owner)).size,
		labels: countBy(rows.flatMap(labelsOf), (x) => x, 6),
		authors: countBy(rows, (r) => r.author_login ?? "未知", 5),
		medianAge: median(ages),
		stale: ages.filter((d) => d > 30).length,
		discussed: rows.filter((r) => (r.comments_count ?? 0) > 0).length,
		weekly: weeklySeries(rows, (r) => r.created_at, now, 12),
	};
}

export const REVIEW_STATES = [
	{ key: "draft", label: "草稿" },
	{ key: "required", label: "待审查" },
	{ key: "changes", label: "需修改" },
	{ key: "approved", label: "已批准" },
	{ key: "none", label: "未标记" },
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number]["key"];
export function reviewState(pr: Pick<PullRow, "is_draft" | "review_decision">): ReviewState {
	if (pr.is_draft) return "draft";
	return pr.review_decision === "APPROVED"
		? "approved"
		: pr.review_decision === "CHANGES_REQUESTED"
			? "changes"
			: pr.review_decision === "REVIEW_REQUIRED"
				? "required"
				: "none";
}
export const PR_SIZES = [
	{ key: "xs", label: "≤ 10 行", max: 10 },
	{ key: "s", label: "≤ 100 行", max: 100 },
	{ key: "m", label: "≤ 500 行", max: 500 },
	{ key: "l", label: "> 500 行", max: Number.POSITIVE_INFINITY },
] as const;

export function pullsBoard(all: PullRow[], now: string, filters: WorkFilters & { review: string }) {
	const { review, ...rest } = filters;
	const scoped = all.filter((r) => !review || reviewState(r) === review);
	const base = workBoard(scoped, now, rest);
	const rows = base.rows;
	return {
		...base,
		review: REVIEW_STATES.map((s) => ({
			...s,
			value: rows.filter((r) => reviewState(r) === s.key).length,
		})),
		sizes: PR_SIZES.map((s, i) => ({
			...s,
			value: rows.filter((r) => {
				const n = r.additions + r.deletions;
				return n <= s.max && (i === 0 || n > (PR_SIZES[i - 1]?.max ?? 0));
			}).length,
		})),
		churn: {
			additions: rows.reduce((n, r) => n + r.additions, 0),
			deletions: rows.reduce((n, r) => n + r.deletions, 0),
		},
	};
}

/** The owner with the most notifications is taken as the account itself; everything else is external. */
export function primaryOwner(rows: { name_with_owner: string }[]): string | null {
	return countBy(rows, (r) => r.name_with_owner.split("/")[0] ?? "", 1).rows[0]?.name ?? null;
}

type FlowRepo = {
	name: string;
	metrics: {
		days: Record<string, { prMerged: number; prOpened: number; prClosed: number }>;
		cycleHours: number[];
	};
};
/** Recent PR throughput from factory metrics, for when no PR is currently open. */
export function mergedHistory(repos: FlowRepo[], now: string, days: number) {
	const end = Date.parse(now.slice(0, 10));
	const since = end - (days - 1) * 86_400_000;
	const daily = Array.from({ length: days }, (_, i) => ({
		x: new Date(since + i * 86_400_000).toISOString().slice(0, 10),
		merged: 0,
		opened: 0,
	}));
	let closed = 0;
	const perRepo: { name: string }[] = [];
	for (const r of repos) {
		for (const [date, v] of Object.entries(r.metrics.days)) {
			const slot = daily.find((d) => d.x === date);
			if (!slot) continue;
			slot.merged += v.prMerged;
			slot.opened += v.prOpened;
			closed += v.prClosed;
			for (let k = 0; k < v.prMerged; k++) perRepo.push({ name: r.name });
		}
	}
	return {
		daily,
		merged: daily.reduce((n, d) => n + d.merged, 0),
		opened: daily.reduce((n, d) => n + d.opened, 0),
		closed,
		repos: countBy(perRepo, (r) => r.name, 8),
		cycleHours: median(repos.flatMap((r) => r.metrics.cycleHours)),
	};
}

export function inboxBoard(
	all: NotificationRow[],
	now: string,
	owner: string | null,
	filters: { reason: string; repo: string; unread: string },
) {
	const rows = all.filter((r) =>
		matchesFilters(
			r,
			{
				reason: (x) => x.reason,
				repo: (x) => x.name_with_owner,
				unread: (x) => (x.unread ? "unread" : "read"),
			},
			filters,
		),
	);
	return {
		rows,
		unread: rows.filter((r) => r.unread).length,
		external: owner ? rows.filter((r) => !r.name_with_owner.startsWith(`${owner}/`)).length : 0,
		reasons: countBy(rows, (r) => r.reason),
		repos: countBy(rows, (r) => r.name_with_owner, 8),
		repoCount: new Set(rows.map((r) => r.name_with_owner)).size,
		daily: dailySeries(
			rows,
			(r) => r.updated_at,
			now,
			30,
			(r) => r.reason,
		),
	};
}

export const SEVERITIES = ["critical", "high", "medium", "low", "other"] as const;
const severityOf = (s: string) => {
	const k = s.toLowerCase();
	return (SEVERITIES as readonly string[]).includes(k) ? k : k === "moderate" ? "medium" : "other";
};
export function alertsBoard(
	all: AlertItem[],
	filters: { severity: string; repo: string; source: string },
) {
	const rows = all.filter((r) =>
		matchesFilters(
			r,
			{
				severity: (x) => severityOf(x.severity),
				repo: (x) => x.name_with_owner,
				source: (x) => x.source,
			},
			filters,
		),
	);
	return {
		rows,
		severity: SEVERITIES.map((key) => ({
			key,
			value: rows.filter((r) => severityOf(r.severity) === key).length,
		})),
		repos: countBy(rows, (r) => r.name_with_owner, 8),
		sources: countBy(rows, (r) => r.source),
	};
}

/** Day-over-day movers; unchanged and unknown rows collapse into a count instead of a long zero table. */
export function digestBoard(repos: DigestRepo[], baselineMissing: boolean) {
	const moved = (r: DigestRepo) => Boolean(r.stars_delta || r.forks_delta || r.open_issues_delta);
	// Stars are rarer than issue churn, so a star change ranks as ten issues.
	const weight = (r: DigestRepo) =>
		Math.abs(Number(r.open_issues_delta)) + Math.abs(Number(r.stars_delta)) * 10;
	const changed = baselineMissing
		? []
		: repos
				.filter(moved)
				.sort(
					(a, b) => weight(b) - weight(a) || a.name_with_owner.localeCompare(b.name_with_owner),
				);
	const deltas = changed.map((r) => Number(r.open_issues_delta));
	return {
		changed,
		unchanged: repos.length - changed.length,
		issues: {
			up: deltas.filter((d) => d > 0).reduce((n, d) => n + d, 0),
			down: deltas.filter((d) => d < 0).reduce((n, d) => n + d, 0),
			max: Math.max(1, ...deltas.map(Math.abs)),
		},
		bars: changed
			.filter((r) => r.open_issues_delta)
			.map((r) => ({
				name: shortRepo(r.name_with_owner),
				repo: r.name_with_owner,
				issues: Number(r.open_issues_delta),
			}))
			.sort((a, b) => b.issues - a.issues || a.name.localeCompare(b.name)),
	};
}

export const REPO_STATUS = [
	{ key: "active", label: "参与统计" },
	{ key: "disabled", label: "已排除" },
	{ key: "fork", label: "Fork" },
	{ key: "archived", label: "已归档" },
] as const;
export const repoStatus = (r: RepoRow) =>
	r.is_archived ? "archived" : r.is_fork ? "fork" : participates(r) ? "active" : "disabled";

export function reposBoard(
	all: RepoRow[],
	now: string,
	filters: { language: string; status: string; age: string },
) {
	const rows = all.filter((r) =>
		matchesFilters(
			r,
			{
				language: (x) => x.primary_language ?? "未标记",
				status: repoStatus,
				age: (x) => ageOf(x.pushed_at, now),
			},
			filters,
		),
	);
	return {
		rows,
		status: REPO_STATUS.map((s) => ({
			...s,
			value: rows.filter((r) => repoStatus(r) === s.key).length,
		})),
		languages: countBy(rows, (r) => r.primary_language ?? "未标记", 8),
		freshness: ageBuckets(
			rows.map((r) => r.pushed_at),
			now,
		),
		stars: {
			rows: [...rows]
				.filter((r) => r.stargazer_count > 0)
				.sort(
					(a, b) =>
						b.stargazer_count - a.stargazer_count ||
						a.name_with_owner.localeCompare(b.name_with_owner),
				)
				.slice(0, 8)
				.map((r) => ({ name: r.name_with_owner, value: r.stargazer_count })),
			max: Math.max(1, ...rows.map((r) => r.stargazer_count)),
		},
		privateCount: rows.filter((r) => r.is_private).length,
	};
}

const FAILED = ["failure", "timed_out", "action_required", "startup_failure"];
export function repoActivityBoard(
	data: { runs: ActionRun[]; releases: RepoRelease[] },
	now: string,
) {
	const outcome = (r: ActionRun) =>
		r.conclusion === null
			? "pending"
			: r.conclusion === "success"
				? "success"
				: FAILED.includes(r.conclusion)
					? "failure"
					: "other";
	const count = (k: string) => data.runs.filter((r) => outcome(r) === k).length;
	const success = count("success");
	const failure = count("failure");
	const minutes = data.runs
		.filter((r) => r.conclusion !== null)
		.map((r) => (Date.parse(r.updated_at) - Date.parse(r.created_at)) / 60_000)
		.filter((m) => Number.isFinite(m) && m > 0);
	const published = data.releases
		.filter((r) => !r.draft && r.published_at)
		.map((r) => ({ ...r, published_at: r.published_at as string }))
		.sort((a, b) => a.published_at.localeCompare(b.published_at));
	const gaps = published
		.slice(1)
		.map((r, i) => daysAgo(published[i]?.published_at, r.published_at) as number);
	return {
		ci: {
			success,
			failure,
			other: count("other"),
			pending: count("pending"),
			rate: success + failure ? success / (success + failure) : null,
			medianMinutes: median(minutes),
			daily: dailySeries(data.runs, (r) => r.created_at, now, 30, outcome),
		},
		workflows: countBy(data.runs, (r) => r.name, 6),
		releases: {
			published: published.length,
			prerelease: published.filter((r) => r.prerelease).length,
			draft: data.releases.filter((r) => r.draft).length,
			cadenceDays: median(gaps),
			timeline: published.map((r) => ({
				tag: r.tag_name,
				at: r.published_at,
				prerelease: r.prerelease,
			})),
		},
	};
}

/** One repository's factory days as a dense series over its observation window. */
export function repoFactorySeries(
	repo: { metrics: { days: Record<string, FactoryDay> } },
	window: { since: string; until: string },
) {
	const start = Date.parse(window.since.slice(0, 10));
	const end = Date.parse(window.until.slice(0, 10));
	if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
	const out = [];
	const ok: number[] = [];
	const bad: number[] = [];
	for (let t = start; t <= end; t += 86_400_000) {
		const x = new Date(t).toISOString().slice(0, 10);
		const d = repo.metrics.days[x];
		ok.push(d?.ciSuccess ?? 0);
		bad.push(d?.ciFailure ?? 0);
		// Trailing 7 days so sparse run days read as a steady rate instead of isolated spikes.
		const s7 = ok.slice(-7).reduce((n, v) => n + v, 0);
		const f7 = bad.slice(-7).reduce((n, v) => n + v, 0);
		out.push({
			x,
			commits: d?.commits ?? 0,
			prMerged: d?.prMerged ?? 0,
			prOpened: d?.prOpened ?? 0,
			issueOpened: d?.issueOpened ?? 0,
			issueClosed: d?.issueClosed ?? 0,
			releases: d?.releases ?? 0,
			ciRate: s7 + f7 ? s7 / (s7 + f7) : null,
		});
	}
	return out;
}
