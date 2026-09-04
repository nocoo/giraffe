import type { IssueRow } from "./issues";
import { loadIssues } from "./issues";
import type { PullRow } from "./pulls";
import { loadPulls } from "./pulls";
import { loadKind } from "./snapshot";

export type Health = "strong" | "watch" | "risky";

export type InsightAlert = {
	name_with_owner: string;
	source: string;
	severity: string;
	summary: string;
	url: string;
};

export type InsightRow = {
	name_with_owner: string;
	open_issue_count: number;
	days_since_push: number;
	health: Health;
	alerts: InsightAlert[];
	opportunities: string[];
};

export type InsightsSnapshot = {
	account_id: string;
	fetched_at: string;
	truncated: boolean;
	alerts_incomplete: boolean;
	insights: InsightRow[];
};

export type ChartPoint = {
	x: string;
	y: number;
	y2?: number;
};

export type NamedValue = {
	name: string;
	value: number;
};

export type InsightsCharts = {
	issueCount: number;
	prCount: number;
	reposWithIssues: number;
	reposWithPrs: number;
	reposWithBoth: number;
	reposQuiet: number;
	strongCount: number;
	watchCount: number;
	riskyCount: number;
	staleCount: number;
	draftCount: number;
	reviewRequiredCount: number;
	changesRequestedCount: number;
	approvedCount: number;
	workloadByRepo: ChartPoint[];
	coverage: NamedValue[];
	health: NamedValue[];
	prStatus: NamedValue[];
	activity: ChartPoint[];
	freshness: ChartPoint[];
};

export type InsightsBoard = {
	insights: InsightsSnapshot;
	issues: IssueRow[] | null;
	pulls: PullRow[] | null;
};

const WORKLOAD_LIMIT = 8;
const ACTIVITY_WEEKS = 8;
const DAY_MS = 86_400_000;

function tally(rows: { name_with_owner: string }[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		counts.set(row.name_with_owner, (counts.get(row.name_with_owner) ?? 0) + 1);
	}
	return counts;
}

function issueCounts(rows: InsightRow[], issues: IssueRow[] | null): Map<string, number> {
	if (issues) {
		return tally(issues);
	}
	return new Map(rows.map((row) => [row.name_with_owner, row.open_issue_count]));
}

function repoNames(
	rows: InsightRow[],
	issues: IssueRow[] | null,
	pulls: PullRow[] | null,
): string[] {
	const names = new Set<string>();
	for (const row of rows) {
		names.add(row.name_with_owner);
	}
	for (const row of issues ?? []) {
		names.add(row.name_with_owner);
	}
	for (const row of pulls ?? []) {
		names.add(row.name_with_owner);
	}
	return [...names];
}

function shortLabel(nameWithOwner: string, names: string[]): string {
	const slash = nameWithOwner.lastIndexOf("/");
	const short = slash >= 0 ? nameWithOwner.slice(slash + 1) : nameWithOwner;
	let clashes = 0;
	for (const name of names) {
		const otherSlash = name.lastIndexOf("/");
		const other = otherSlash >= 0 ? name.slice(otherSlash + 1) : name;
		if (other === short) {
			clashes += 1;
			if (clashes > 1) {
				return nameWithOwner;
			}
		}
	}
	return short;
}

function named(entries: [string, number][]): NamedValue[] {
	return entries.filter(([, value]) => value > 0).map(([name, value]) => ({ name, value }));
}

function mondayUtc(ts: number): number {
	const date = new Date(ts);
	const offset = (date.getUTCDay() + 6) % 7;
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - offset);
}

function weekLabel(ts: number): string {
	const monday = new Date(mondayUtc(ts));
	const month = String(monday.getUTCMonth() + 1).padStart(2, "0");
	const day = String(monday.getUTCDate()).padStart(2, "0");
	return `${month}-${day}`;
}

function activitySeries(
	fetchedAt: string,
	issues: IssueRow[] | null,
	pulls: PullRow[] | null,
): ChartPoint[] {
	const end = Date.parse(fetchedAt);
	if (!Number.isFinite(end)) {
		return [];
	}
	const lastMonday = mondayUtc(end);
	const weeks: { x: string; start: number }[] = [];
	for (let i = ACTIVITY_WEEKS - 1; i >= 0; i -= 1) {
		const start = lastMonday - i * 7 * DAY_MS;
		weeks.push({ x: weekLabel(start), start });
	}
	const index = new Map(weeks.map((week, i) => [week.start, i]));
	const points: ChartPoint[] = weeks.map((week) => ({ x: week.x, y: 0, y2: 0 }));
	for (const row of issues ?? []) {
		const ts = Date.parse(row.created_at);
		if (!Number.isFinite(ts)) {
			continue;
		}
		const slot = index.get(mondayUtc(ts));
		if (slot === undefined) {
			continue;
		}
		const point = points[slot];
		if (point) {
			point.y += 1;
		}
	}
	for (const row of pulls ?? []) {
		const ts = Date.parse(row.created_at);
		if (!Number.isFinite(ts)) {
			continue;
		}
		const slot = index.get(mondayUtc(ts));
		if (slot === undefined) {
			continue;
		}
		const point = points[slot];
		if (point) {
			point.y2 = (point.y2 ?? 0) + 1;
		}
	}
	return points;
}

function freshnessBars(rows: InsightRow[]): ChartPoint[] {
	const week = { x: "7 天内", y: 0 };
	const month = { x: "30 天内", y: 0 };
	const quarter = { x: "90 天内", y: 0 };
	const older = { x: "更久", y: 0 };
	for (const row of rows) {
		if (row.days_since_push <= 7) {
			week.y += 1;
		} else if (row.days_since_push <= 30) {
			month.y += 1;
		} else if (row.days_since_push <= 90) {
			quarter.y += 1;
		} else {
			older.y += 1;
		}
	}
	return [week, month, quarter, older];
}

export function buildInsightsCharts(
	rows: InsightRow[],
	issues: IssueRow[] | null,
	pulls: PullRow[] | null,
	fetchedAt: string,
): InsightsCharts {
	const issueMap = issueCounts(rows, issues);
	const prMap = pulls ? tally(pulls) : new Map<string, number>();
	const names = repoNames(rows, issues, pulls);
	const workload: { name: string; y: number; y2: number }[] = [];
	let reposWithIssues = 0;
	let reposWithPrs = 0;
	let reposWithBoth = 0;
	let reposQuiet = 0;
	for (const name of names) {
		const y = issueMap.get(name) ?? 0;
		const y2 = prMap.get(name) ?? 0;
		if (y > 0 && y2 > 0) {
			reposWithBoth += 1;
		} else if (y > 0) {
			reposWithIssues += 1;
		} else if (y2 > 0) {
			reposWithPrs += 1;
		} else {
			reposQuiet += 1;
		}
		if (y + y2 > 0) {
			workload.push({ name, y, y2 });
		}
	}
	workload.sort((a, b) => b.y + b.y2 - (a.y + a.y2) || a.name.localeCompare(b.name));
	const top = workload.slice(0, WORKLOAD_LIMIT);
	const rest = workload.slice(WORKLOAD_LIMIT);
	const workloadByRepo: ChartPoint[] = top.map((row) => ({
		x: shortLabel(row.name, names),
		y: row.y,
		y2: row.y2,
	}));
	if (rest.length > 0) {
		workloadByRepo.push({
			x: "其他",
			y: rest.reduce((sum, row) => sum + row.y, 0),
			y2: rest.reduce((sum, row) => sum + row.y2, 0),
		});
	}
	let strongCount = 0;
	let watchCount = 0;
	let riskyCount = 0;
	let staleCount = 0;
	for (const row of rows) {
		if (row.health === "strong") {
			strongCount += 1;
		} else if (row.health === "watch") {
			watchCount += 1;
		} else {
			riskyCount += 1;
		}
		if (row.days_since_push >= 90) {
			staleCount += 1;
		}
	}
	let draftCount = 0;
	let reviewRequiredCount = 0;
	let changesRequestedCount = 0;
	let approvedCount = 0;
	let unmarkedCount = 0;
	for (const row of pulls ?? []) {
		if (row.is_draft) {
			draftCount += 1;
		} else if (row.review_decision === "APPROVED") {
			approvedCount += 1;
		} else if (row.review_decision === "CHANGES_REQUESTED") {
			changesRequestedCount += 1;
		} else if (row.review_decision === "REVIEW_REQUIRED") {
			reviewRequiredCount += 1;
		} else {
			unmarkedCount += 1;
		}
	}
	let issueCount = 0;
	for (const count of issueMap.values()) {
		issueCount += count;
	}
	let prCount = 0;
	for (const count of prMap.values()) {
		prCount += count;
	}
	return {
		issueCount,
		prCount,
		reposWithIssues,
		reposWithPrs,
		reposWithBoth,
		reposQuiet,
		strongCount,
		watchCount,
		riskyCount,
		staleCount,
		draftCount,
		reviewRequiredCount,
		changesRequestedCount,
		approvedCount,
		workloadByRepo,
		coverage: named([
			["仅 Issue", reposWithIssues],
			["仅 PR", reposWithPrs],
			["两者都有", reposWithBoth],
			["暂无", reposQuiet],
		]),
		health: named([
			["健康", strongCount],
			["观察", watchCount],
			["风险", riskyCount],
		]),
		prStatus: named([
			["草稿", draftCount],
			["待审查", reviewRequiredCount],
			["需修改", changesRequestedCount],
			["已批准", approvedCount],
			["未标记", unmarkedCount],
		]),
		activity: activitySeries(fetchedAt, issues, pulls),
		freshness: freshnessBars(rows),
	};
}

export function groupInsights(rows: InsightRow[]): Record<Health, InsightRow[]> {
	return {
		strong: rows.filter((row) => row.health === "strong"),
		watch: rows.filter((row) => row.health === "watch"),
		risky: rows.filter((row) => row.health === "risky"),
	};
}

export function filterInsights(rows: InsightRow[], health: Health | "all"): InsightRow[] {
	if (health === "all") {
		return rows;
	}
	return rows.filter((row) => row.health === health);
}

export type InsightSort = "issues" | "days" | "name";

export function sortInsights(rows: InsightRow[], key: InsightSort): InsightRow[] {
	const copy = [...rows];
	copy.sort((a, b) => {
		if (key === "issues") {
			return b.open_issue_count - a.open_issue_count;
		}
		if (key === "days") {
			return b.days_since_push - a.days_since_push;
		}
		return a.name_with_owner.localeCompare(b.name_with_owner);
	});
	return copy;
}

export function alertsIncomplete(snap: InsightsSnapshot | null): boolean {
	return snap?.alerts_incomplete === true;
}

export async function loadInsights(): Promise<InsightsSnapshot | { missing: true }> {
	return loadKind<InsightsSnapshot>("insights");
}

export async function loadInsightsBoard(): Promise<InsightsBoard | { missing: true }> {
	const [insights, issuesSnap, pullsSnap] = await Promise.all([
		loadInsights(),
		loadIssues(),
		loadPulls(),
	]);
	if ("missing" in insights) {
		return insights;
	}
	return {
		insights,
		issues: "missing" in issuesSnap ? null : issuesSnap.issues,
		pulls: "missing" in pullsSnap ? null : pullsSnap.pull_requests,
	};
}
