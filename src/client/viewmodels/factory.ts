import { aggregateFactory, emptyDay } from "../../lib/factory";
import {
	FACTORY_STREAMS,
	type FactoryCoverage,
	type FactoryDay,
	type FactoryEvent,
	type FactoryRepo,
	type FactorySnapshot,
	type FactoryStreamName,
	type FactoryWindow,
} from "../../lib/factory-types";
import { apiGet } from "../lib/api";
import { ApiError } from "../lib/errors";
import { ensureSession, getActiveAccountId } from "./session";
import { fetchKind, loadKind } from "./snapshot";

export type FactoryFilter = { language: string; topic: string; query: string; repo: string };
export const STREAM_LABELS: Record<FactoryStreamName, string> = {
	commits: "提交",
	issues: "Issues",
	prs: "Pull requests",
	actions: "CI / Actions",
	releases: "Releases",
	alerts: "依赖告警",
	dependencies: "依赖证据",
};
export const STATUS_LABELS: Record<FactoryCoverage["status"], string> = {
	pending: "未采集",
	partial: "分页中",
	complete: "完整",
	unavailable: "不可用",
	limited: "已截断",
};
export type FactoryDetail = {
	account_id: string;
	runId: string;
	repo: string;
	stream: FactoryStreamName;
	coverage: FactoryCoverage;
	page: number;
	total: number;
	items: FactoryEvent[];
};
export const loadFactory = () => loadKind<FactorySnapshot>("factory");
export const reloadFactory = () => fetchKind<FactorySnapshot>("factory");
export async function loadFactoryDetail(
	repo: string,
	stream: FactoryStreamName,
	page = 1,
	state = "",
	day = "",
): Promise<FactoryDetail | null> {
	const stamp = await ensureSession();
	const result = await apiGet<FactoryDetail>(
		`factory/repos/${repo}/${stream}?page=${page}&state=${encodeURIComponent(state)}&day=${encodeURIComponent(day)}`,
	);
	if (getActiveAccountId() !== stamp || result.account_id !== stamp) return null;
	return result;
}
export function factoryError(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.code === "factory_capacity")
			return "存储空间或仓库数量达到上限。已有数据保留；请缩小刷新范围，并查看存储用量。";
		if (error.code === "refresh_cooldown") return "刚刚发起过刷新，请等倒计时结束后再试。";
		if (error.code === "catalog_incomplete")
			return "仓库列表还没读完整，请先点击「同步仓库列表」。";
		if (error.code === "github_rate_limited")
			return "GitHub 暂时限制了请求频率，已获取的数据已保存，等待请求额度恢复后继续。";
		if (error.code === "account_conflict")
			return "账号已切换，或已有刷新正在进行。请更新状态后继续。";
		if (error.code === "account_missing") return "请先在设置中连接 GitHub 账号。";
		if (error.code === "github_unauthorized") return "GitHub 令牌失效，请在设置中更新。";
	}
	return "暂时无法完成操作。已有数据和刷新进度保留，请稍后重试。";
}
export function filterFactoryRepos(repos: FactoryRepo[], f: FactoryFilter): FactoryRepo[] {
	const q = f.query.trim().toLowerCase();
	return repos.filter(
		(r) =>
			(!f.language || r.language === f.language) &&
			(!f.topic || r.topics.includes(f.topic)) &&
			(!f.repo || r.name === f.repo) &&
			(!q || `${r.name} ${r.description ?? ""}`.toLowerCase().includes(q)),
	);
}
export function factoryGroups(repos: FactoryRepo[]) {
	return {
		languages: [...new Set(repos.map((r) => r.language))].sort(),
		topics: [...new Set(repos.flatMap((r) => r.topics))].sort(),
	};
}
export function factoryBoard(snapshot: FactorySnapshot, repos: FactoryRepo[]) {
	const aggregate = aggregateFactory(repos);
	const windows = repos.length
		? repos.map((r) => r.observation?.window ?? snapshot.window)
		: [snapshot.window];
	const end = Math.max(...windows.map((w) => Date.parse(w.until)));
	const earliest = Math.min(...windows.map((w) => Date.parse(w.since)));
	const start = Math.max(
		earliest,
		Date.parse(new Date(end).toISOString().slice(0, 10)) - 365 * 86400_000,
	);
	const mixedWindows = windows.some(
		(w) => w.since !== windows[0]?.since || w.until !== windows[0]?.until,
	);
	const days: BoardDay[] = [];
	for (let date = start; date < end; date += 86400_000) {
		const day = new Date(date).toISOString().slice(0, 10);
		const complete = Object.fromEntries(
			FACTORY_STREAMS.map((stream) => [
				stream,
				repos.every((r) => {
					const window = r.observation?.window ?? snapshot.window;
					return (
						r.coverage[stream].status === "complete" &&
						date >= Date.parse(window.since) &&
						date < Date.parse(window.until)
					);
				}),
			]),
		) as Record<FactoryStreamName, boolean>;
		days.push({ date: day, ...(aggregate.days[day] ?? emptyDay()), complete });
	}
	const coverage = {
		complete: 0,
		total: repos.length * FACTORY_STREAMS.length,
		unavailable: 0,
		limited: 0,
	};
	for (const r of repos)
		for (const stream of FACTORY_STREAMS) {
			const status = r.coverage[stream].status;
			if (status === "complete") coverage.complete++;
			if (status === "unavailable") coverage.unavailable++;
			if (status === "limited") coverage.limited++;
		}
	const midnight = Date.parse(new Date(end).toISOString().slice(0, 10));
	const windowOf = (r: FactoryRepo) => r.observation?.window ?? snapshot.window;
	// Periods end at the last UTC day every repository observed in full, so comparisons never mix a partial day.
	const periodEnd = repos.length
		? Math.min(...repos.map((r) => Date.parse(windowOf(r).until.slice(0, 10))))
		: midnight;
	const repoActivity = repos.map((r) => activityOf(r, periodEnd));
	const series = addStock(days, repos);
	const stockOn = (date: string, key: "openIssues" | "openPrs") =>
		series.find((d) => d.date === date)?.[key] ?? null;
	const periods = PERIODS.map((length) => {
		const summary = periodSummary(repos, windowOf, periodEnd, length);
		const before = isoDay(Date.parse(summary.since) - DAY_MS);
		return {
			...summary,
			stock: {
				openIssues: {
					from: stockOn(before, "openIssues"),
					to: stockOn(summary.until, "openIssues"),
				},
				openPrs: { from: stockOn(before, "openPrs"), to: stockOn(summary.until, "openPrs") },
			},
		};
	});
	const languageBytes = new Map<string, number>();
	for (const r of repos)
		for (const l of r.languages)
			languageBytes.set(l.name, (languageBytes.get(l.name) ?? 0) + l.bytes);
	const languageTotal = [...languageBytes.values()].reduce((a, b) => a + b, 0);
	const languages = [...languageBytes]
		.map(([name, bytes]) => ({ name, bytes, share: languageTotal ? bytes / languageTotal : 0 }))
		.sort((a, b) => b.bytes - a.bytes);
	const observed = Object.fromEntries(
		FACTORY_STREAMS.map((k) => [
			k,
			repos.some(
				(r) =>
					r.coverage[k].status === "complete" ||
					(r.coverage[k].status !== "pending" &&
						r.coverage[k].status !== "partial" &&
						r.coverage[k].observed > 0),
			),
		]),
	) as Record<FactoryStreamName, boolean>;

	return {
		mixedWindows,
		displayWindow: { since: new Date(start).toISOString(), until: new Date(end).toISOString() },
		aggregate,
		streamComplete: Object.fromEntries(
			FACTORY_STREAMS.map((k) => [
				k,
				repos.filter((r) => r.coverage[k].status === "complete").length,
			]),
		) as Record<FactoryStreamName, number>,
		languages,
		observed,
		days: series,
		coverage,
		totals: {
			repos: repos.length,
			private: repos.filter((r) => r.private).length,
			sizeKiB: repos.reduce((n, r) => n + r.diskKiB, 0),
			languageBytes: repos.reduce((n, r) => n + r.languageBytes, 0),
			allCommits: repos.reduce((n, r) => n + r.totalCommits, 0),
			openIssues: repos.reduce((n, r) => n + r.openIssues, 0),
			closedIssues: repos.reduce((n, r) => n + r.closedIssues, 0),
			openPrs: repos.reduce((n, r) => n + r.openPrs, 0),
			closedPrs: repos.reduce((n, r) => n + r.closedPrs, 0),
			mergedPrs: repos.reduce((n, r) => n + r.mergedPrs, 0),
		},
		periods,
		repoActivity,
		activity: activityBuckets(repoActivity, periodEnd),
		ranking: [...repos].sort(
			(a, b) => b.metrics.commits - a.metrics.commits || a.name.localeCompare(b.name),
		),
		anomalies: repos.flatMap((r) => {
			const signals: { repo: string; label: string; stream: FactoryStreamName }[] = [];
			if (r.metrics.agedPrs)
				signals.push({
					repo: r.name,
					label: `${r.metrics.agedPrs} 个 open PR ≥7 天`,
					stream: "prs",
				});
			if (r.metrics.agedIssues)
				signals.push({
					repo: r.name,
					label: `${r.metrics.agedIssues} 个 open issue ≥14 天`,
					stream: "issues",
				});
			const decisive = r.metrics.ciSuccess + r.metrics.ciFailure;
			if (decisive >= 10 && r.metrics.ciFailure / decisive >= 0.2)
				signals.push({
					repo: r.name,
					label: `CI 失败 ${r.metrics.ciFailure}/${decisive}`,
					stream: "actions",
				});
			if (r.metrics.alerts)
				signals.push({
					repo: r.name,
					label: `${r.metrics.alerts} 个开放依赖告警`,
					stream: "alerts",
				});
			return signals;
		}),
	};
}
const DAY_MS = 86_400_000;
export const PERIODS = [1, 7, 30] as const;
export type Period = (typeof PERIODS)[number];
type Flow = {
	commits: number;
	prOpened: number;
	prMerged: number;
	prClosed: number;
	issueOpened: number;
	issueClosed: number;
	releases: number;
	ciSuccess: number;
	ciFailure: number;
};
const FLOW_KEYS = [
	"commits",
	"prOpened",
	"prMerged",
	"prClosed",
	"issueOpened",
	"issueClosed",
	"releases",
	"ciSuccess",
	"ciFailure",
] as const satisfies readonly (keyof Flow)[];
const PERIOD_STREAMS = ["commits", "issues", "prs", "actions", "releases"] as const;
const emptyFlow = (): Flow => Object.fromEntries(FLOW_KEYS.map((k) => [k, 0])) as Flow;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

function sumFlow(days: Record<string, Flow>, from: number, to: number): Flow {
	const flow = emptyFlow();
	for (const [date, value] of Object.entries(days)) {
		const t = Date.parse(date);
		if (t < from || t >= to) continue;
		for (const k of FLOW_KEYS) flow[k] += value[k];
	}
	return flow;
}

function activityOf(r: FactoryRepo, midnight: number) {
	let last: string | undefined;
	for (const [date, value] of Object.entries(r.metrics.days))
		if (value.commits && date < isoDay(midnight + DAY_MS) && date > (last ?? "")) last = date;
	const known = {
		commits: hasFactoryMeasurement(r, "commits"),
		issues: r.coverage.issues.status === "complete",
		prs: r.coverage.prs.status === "complete",
	};
	return {
		name: r.name,
		language: r.language,
		private: r.private,
		last,
		periods: Object.fromEntries(
			PERIODS.map((n) => [n, sumFlow(r.metrics.days, midnight - n * DAY_MS, midnight)]),
		) as Record<Period, Flow>,
		previous7: sumFlow(r.metrics.days, midnight - 14 * DAY_MS, midnight - 7 * DAY_MS).commits,
		openIssues: r.openIssues,
		openPrs: r.openPrs,
		agedIssues: known.issues ? r.metrics.agedIssues : null,
		agedPrs: known.prs ? r.metrics.agedPrs : null,
		known,
	};
}
export type RepoActivity = ReturnType<typeof activityOf>;

function periodSummary(
	repos: FactoryRepo[],
	windowOf: (r: FactoryRepo) => FactoryWindow,
	midnight: number,
	length: Period,
) {
	const since = midnight - length * DAY_MS;
	const previousSince = since - length * DAY_MS;
	const covered = (from: number) =>
		Object.fromEntries(
			PERIOD_STREAMS.map((stream) => [
				stream,
				repos.length > 0 &&
					repos.every(
						(r) =>
							r.coverage[stream].status === "complete" &&
							Date.parse(windowOf(r).since) <= from &&
							Date.parse(windowOf(r).until) >= midnight,
					),
			]),
		) as Record<(typeof PERIOD_STREAMS)[number], boolean>;
	const total = (from: number, to: number) => {
		const flow = emptyFlow();
		let active = 0;
		for (const r of repos) {
			const part = sumFlow(r.metrics.days, from, to);
			for (const k of FLOW_KEYS) flow[k] += part[k];
			if (part.commits) active++;
		}
		return { ...flow, active };
	};
	return {
		days: length,
		since: isoDay(since),
		until: isoDay(midnight - DAY_MS),
		current: total(since, midnight),
		previous: total(previousSince, since),
		complete: covered(since),
		previousComplete: covered(previousSince),
	};
}
export type PeriodSummary = ReturnType<typeof periodSummary> & {
	stock: Record<"openIssues" | "openPrs", { from: number | null; to: number | null }>;
};

function activityBuckets(activity: RepoActivity[], midnight: number) {
	const buckets = { week: 0, month: 0, dormant: 0, unknown: 0 };
	for (const r of activity) {
		if (!r.known.commits) buckets.unknown++;
		else if (Date.parse(r.last ?? "") >= midnight - 7 * DAY_MS) buckets.week++;
		else if (Date.parse(r.last ?? "") >= midnight - 30 * DAY_MS) buckets.month++;
		else buckets.dormant++;
	}
	return buckets;
}

type BoardDay = FactoryDay & { date: string; complete: Record<FactoryStreamName, boolean> };
/**
 * Open backlog is only observed today. Walking backwards (open(d-1) = open(d) - opened(d) + closed(d))
 * is exact only when every repository's event list is complete; a negative result proves missing
 * events, so that day and every earlier day are withheld.
 */
function walkBack(days: BoardDay[], now: number | null, net: (d: BoardDay) => number) {
	const out: (number | null)[] = new Array(days.length).fill(null);
	let open = now;
	for (let i = days.length - 1; i >= 0 && open !== null && open >= 0; i--) {
		out[i] = open;
		open -= net(days[i] as BoardDay);
	}
	return out;
}

function addStock(days: BoardDay[], repos: FactoryRepo[]) {
	const exact = (stream: "issues" | "prs") =>
		repos.length > 0 && repos.every((r) => r.coverage[stream].status === "complete");
	const sum = (key: "openIssues" | "openPrs") => repos.reduce((n, r) => n + r[key], 0);
	const openIssues = walkBack(
		days,
		exact("issues") ? sum("openIssues") : null,
		(d) => d.issueOpened - d.issueClosed,
	);
	const openPrs = walkBack(
		days,
		exact("prs") ? sum("openPrs") : null,
		(d) => d.prOpened - d.prMerged - d.prClosed,
	);
	const commitKnown = repos.length > 0 && repos.every((r) => hasFactoryMeasurement(r, "commits"));
	const ciKnown = repos.length > 0 && repos.every((r) => r.coverage.actions.status === "complete");
	const index = new Map(days.map((d, i) => [d.date, i]));
	const commitDays = repos.map((r) =>
		Object.entries(r.metrics.days)
			.filter(([, v]) => v.commits > 0)
			.map(([date]) => index.get(date))
			.filter((i): i is number => i !== undefined)
			.sort((a, b) => a - b),
	);
	let success = 0;
	let failure = 0;
	return days.map((d, i) => {
		success += d.ciSuccess - (days[i - 7]?.ciSuccess ?? 0);
		failure += d.ciFailure - (days[i - 7]?.ciFailure ?? 0);
		const rolling = i >= 6;
		return {
			...d,
			openIssues: openIssues[i] ?? null,
			openPrs: openPrs[i] ?? null,
			ciRate7: ciKnown && rolling && success + failure ? success / (success + failure) : null,
			activeRepos7:
				commitKnown && rolling
					? commitDays.filter((list) => list.some((k) => k <= i && k > i - 7)).length
					: null,
		};
	});
}

export function backlogRows(activity: RepoActivity[]) {
	const rows = activity
		.map((r) => ({
			name: r.name,
			language: r.language,
			openIssues: r.openIssues,
			openPrs: r.openPrs,
			agedIssues: r.agedIssues,
			agedPrs: r.agedPrs,
			total: r.openIssues + r.openPrs,
			done30: r.periods[30].issueClosed + r.periods[30].prMerged,
		}))
		.filter((r) => r.total > 0)
		.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
	return {
		rows,
		openIssues: rows.reduce((n, r) => n + r.openIssues, 0),
		openPrs: rows.reduce((n, r) => n + r.openPrs, 0),
		aged: rows.reduce((n, r) => n + (r.agedIssues ?? 0) + (r.agedPrs ?? 0), 0),
		clear: activity.length - rows.length,
		max: Math.max(1, ...rows.map((r) => r.total)),
	};
}

function median(values: number[]): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const upper = sorted[mid] as number;
	return sorted.length % 2 ? upper : ((sorted[mid - 1] as number) + upper) / 2;
}
/** Low activity with above-median backlog marks where work is accumulating. */
export function activityQuadrant(activity: RepoActivity[]) {
	const points = activity
		.filter((r) => r.known.commits)
		.map((r) => ({
			name: r.name,
			language: r.language,
			commits: r.periods[30].commits,
			backlog: r.openIssues + r.openPrs,
			last: r.last,
		}));
	const medianCommits = median(points.map((p) => p.commits));
	const medianBacklog = median(points.map((p) => p.backlog));
	return {
		points,
		medianCommits,
		medianBacklog,
		stalled: points
			.filter((p) => p.commits < medianCommits && p.backlog > medianBacklog)
			.sort((a, b) => b.backlog - a.backlog),
	};
}

export function periodChange(
	current: number | null,
	previous: number | null,
	kind: "count" | "rate" | "delta" = "count",
): { label: string; direction: "up" | "down" | "flat" } {
	if (current === null || previous === null) return { label: "—", direction: "flat" };
	// Net flows can cross zero, where a percentage is meaningless.
	if (kind === "delta") {
		const d = current - previous;
		return d
			? { label: `${d > 0 ? "+" : ""}${formatFactoryCount(d)}`, direction: d > 0 ? "up" : "down" }
			: { label: "持平", direction: "flat" };
	}
	if (kind === "rate") {
		const pp = (current - previous) * 100;
		return {
			label: `${pp >= 0 ? "+" : ""}${pp.toFixed(1)}pp`,
			direction: pp > 0 ? "up" : pp < 0 ? "down" : "flat",
		};
	}
	if (!previous)
		return current ? { label: "新增", direction: "up" } : { label: "—", direction: "flat" };
	if (current === previous) return { label: "持平", direction: "flat" };
	const change = Math.round(((current - previous) / previous) * 100);
	return { label: `${change > 0 ? "+" : ""}${change}%`, direction: change > 0 ? "up" : "down" };
}
export function activityAge(date: string | undefined, until: string): string {
	if (!date) return "窗口内无提交";
	const midnight = Date.parse(until.slice(0, 10));
	const age = Math.round((midnight - Date.parse(date)) / DAY_MS);
	return age <= 0 ? "今天" : age === 1 ? "昨天" : `${age} 天前`;
}
export function dependencyEdges(repos: FactoryRepo[]) {
	const names = new Set(repos.map((r) => r.name));
	const packages = new Map<string, string | null>();
	for (const r of repos)
		for (const d of r.dependencies) {
			if (d.path !== "package.json#name") continue;
			if (!packages.has(d.name)) packages.set(d.name, r.name);
			else if (packages.get(d.name) !== r.name) packages.set(d.name, null);
		}

	const edges = new Map<
		string,
		{ source: string; target: string; references: number; url: string }
	>();
	for (const r of repos)
		for (const d of r.dependencies) {
			if (d.path === "package.json#name") continue;
			const target = d.path.startsWith(".github/workflows/")
				? d.name.split("/").slice(0, 2).join("/")
				: packages.get(d.name);
			if (!target || !names.has(target) || target === r.name) continue;
			const key = `${r.name}:${target}`;
			const old = edges.get(key);
			edges.set(key, {
				source: r.name,
				target,
				references: (old?.references ?? 0) + 1,
				url: d.url,
			});
		}
	return [...edges.values()].sort(
		(a, b) => b.references - a.references || a.source.localeCompare(b.source),
	);
}
export function eventPage(items: FactoryEvent[], query: string, state: string) {
	const q = query.toLowerCase();
	return items.filter(
		(e) =>
			(!state || e.state === state) &&
			(!q || `${e.title} ${e.id} ${e.author}`.toLowerCase().includes(q)),
	);
}
export function safeGithubUrl(url: string): string {
	try {
		const u = new URL(url);
		return u.protocol === "https:" && u.hostname === "github.com" && !u.username && !u.password
			? url
			: "https://github.com";
	} catch {
		return "https://github.com";
	}
}
export function formatFactoryCount(n: number): string {
	return n.toLocaleString("en-US");
}
export function formatHours(n: number | null): string {
	return n === null
		? "—"
		: n < 1
			? `${(n * 60).toFixed(1)} min`
			: n < 24
				? `${n.toFixed(1)} h`
				: `${(n / 24).toFixed(1)} d`;
}
export function formatRate(n: number | null): string {
	return n === null ? "—" : `${(n * 100).toFixed(1)}%`;
}
export function formatUtc(at: string | null): string {
	return at ? `${new Date(at).toISOString().replace("T", " ").slice(0, 19)} UTC` : "未采集";
}

export function factoryParams(
	current: URLSearchParams,
	key: string,
	value: string,
): URLSearchParams {
	const next = new URLSearchParams(current);
	if (value) next.set(key, value);
	else next.delete(key);
	if (key !== "page") next.delete("page");
	if (["language", "topic", "q"].includes(key)) next.delete("repo");
	if (key === "stream") {
		next.delete("state");
		next.delete("day");
	}
	return next;
}

export function factoryRepoPage(repos: FactoryRepo[], page: number) {
	const pages = Math.max(1, Math.ceil(repos.length / 25));
	const current = Math.min(pages, Math.max(1, page));
	return { rows: repos.slice((current - 1) * 25, current * 25), current, pages };
}

export const STREAM_CODES: Record<FactoryStreamName, string> = {
	commits: "C",
	issues: "I",
	prs: "PR",
	actions: "CI",
	releases: "R",
	alerts: "A",
	dependencies: "D",
};
export function hasFactoryMeasurement(repo: FactoryRepo, stream: FactoryStreamName): boolean {
	const coverage = repo.coverage[stream];
	return coverage.status === "complete" || (coverage.status === "limited" && coverage.observed > 0);
}

export function formatObservedCount(value: number, complete: boolean): string {
	return `${complete ? "" : "≥ "}${formatFactoryCount(value)}`;
}

export function factoryRepoCount(
	repo: FactoryRepo,
	stream: "commits" | "prs" | "releases",
): string {
	const fields = { commits: "commits", prs: "prMerged", releases: "releases" } as const;
	return hasFactoryMeasurement(repo, stream)
		? formatObservedCount(repo.metrics[fields[stream]], repo.coverage[stream].status === "complete")
		: "—";
}
