import { aggregateFactory, emptyDay } from "../../lib/factory";
import { factoryEvidenceFreshness } from "../../lib/factory-freshness";
import {
	FACTORY_STREAMS,
	type FactoryCoverage,
	type FactoryDay,
	type FactoryEvent,
	type FactoryRepo,
	type FactorySelectedRepo,
	type FactorySnapshot,
	type FactoryStreamName,
	type FactoryViewSnapshot,
	type FactoryWindow,
} from "../../lib/factory-types";
import { type SnapshotFreshness, snapshotFreshness } from "../../lib/snapshot-freshness";
import { apiGet } from "../lib/api";
import { ApiError } from "../lib/errors";
import { getRepositoryScope, scopedResource } from "./scope";
import { ensureSession, getActiveAccountId } from "./session";
import { fetchKind, loadKind } from "./snapshot";

export type FactoryFilter = { language: string; topic: string; query: string };
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
export const loadFactory = (scope = getRepositoryScope()) =>
	loadKind<FactoryViewSnapshot>(scopedResource("factory", scope));
export const reloadFactory = (scope = getRepositoryScope()) =>
	fetchKind<FactoryViewSnapshot>(scopedResource("factory", scope));

export function factoryFreshness(repos: FactoryRepo[]): SnapshotFreshness {
	return factoryEvidenceFreshness(repos);
}
export async function loadFactoryDetail(
	repo: string,
	stream: FactoryStreamName,
	page = 1,
	state = "",
	day = "",
	scope = getRepositoryScope(),
): Promise<FactoryDetail | null> {
	const stamp = await ensureSession();
	const result = await apiGet<FactoryDetail>(
		scopedResource(
			`factory/repos/${repo}/${stream}?page=${page}&state=${encodeURIComponent(state)}&day=${encodeURIComponent(day)}`,
			scope,
		),
	);
	if (getActiveAccountId() !== stamp || result.account_id !== stamp) return null;
	return result;
}
export function factoryError(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.code === "account_conflict") return "账号已切换，请重新读取已保存的快照。";
		if (error.code === "account_missing") return "请先在设置中连接 GitHub 账号。";
		if (error.code === "github_unauthorized") return "GitHub 令牌失效，请在设置中更新。";
	}
	return "暂时无法读取已保存的快照，请稍后重试。";
}
export function filterFactoryRepos<Repo extends FactorySelectedRepo>(
	repos: Repo[],
	f: FactoryFilter,
): Repo[] {
	const q = f.query.trim().toLowerCase();
	return repos.filter(
		(r) =>
			(!f.language || r.language === null || r.language === f.language) &&
			(!f.topic || r.topics === null || r.topics.includes(f.topic)) &&
			(!q || `${r.name} ${r.description ?? ""}`.toLowerCase().includes(q)),
	);
}
export function factoryGroups(repos: FactorySelectedRepo[]) {
	return {
		languages: [
			...new Set(
				repos.map((r) => r.language).filter((language): language is string => language !== null),
			),
		].sort(),
		topics: [...new Set(repos.flatMap((r) => r.topics ?? []))].sort(),
	};
}
export function factoryBoard(
	snapshot: FactorySnapshot,
	repos: FactoryRepo[],
	selectedRepos: FactorySelectedRepo[],
) {
	const selectedNames = new Set(selectedRepos.map((repo) => repo.name.toLowerCase()));
	repos = repos.filter((repo) => selectedNames.has(repo.name.toLowerCase()));
	const observations = new Map(repos.map((repo) => [repo.name.toLowerCase(), repo]));
	const unpublished = selectedRepos.filter((repo) => !observations.has(repo.name.toLowerCase()));
	const membershipComplete = unpublished.length === 0;
	const aggregate = aggregateFactory(repos);
	const windowOf: StreamWindow = (repo, stream) =>
		repo.coverage[stream].observation?.window ??
		repo.observation?.collectionWindow ??
		repo.observation?.window ??
		snapshot.window;
	const windows = repos.length
		? repos.flatMap((repo) => [
				repo.observation?.window ?? snapshot.window,
				...FACTORY_STREAMS.flatMap(
					(stream) => repo.coverage[stream].completeWindows ?? [windowOf(repo, stream)],
				),
			])
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
				selectedRepos.length > 0 &&
					membershipComplete &&
					repos.every((repo) =>
						coversWindow(repo, stream, windowOf, date, Math.min(date + DAY_MS, end)),
					),
			]),
		) as Record<FactoryStreamName, boolean>;
		days.push({ date: day, ...(aggregate.days[day] ?? emptyDay()), complete });
	}
	const coverage = {
		complete: 0,
		total: selectedRepos.length * FACTORY_STREAMS.length,
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
	const periodEnd = repos.length
		? Math.min(
				...repos.map((r) =>
					Date.parse((r.observation?.window ?? snapshot.window).until.slice(0, 10)),
				),
			)
		: midnight;
	const repoActivity = repos.map((r) =>
		activityOf(
			r,
			windowOf,
			periodEnd,
			Date.parse((r.observation?.window ?? snapshot.window).until),
		),
	);
	const series = addStock(days, repos, membershipComplete);
	const stockOn = (date: string, key: "openIssues" | "openPrs") =>
		series.find((d) => d.date === date)?.[key] ?? null;
	const periods = PERIODS.map((length) => {
		const summary = periodSummary(repos, windowOf, periodEnd, length, membershipComplete);
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
	const activity = activityBuckets(repoActivity, periodEnd);
	activity.unknown += unpublished.length;

	return {
		freshness: factoryEvidenceFreshness(
			selectedRepos.map((repo) => observations.get(repo.name.toLowerCase())),
		),
		metadataFreshness: snapshotFreshness(
			selectedRepos.map((repo) => {
				const observed = observations.get(repo.name.toLowerCase());
				return observed?.metadataAt ?? observed?.observation?.metadataAt;
			}),
		),
		unpublished,
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
			repos: selectedRepos.length,
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
		activity,
		ranking: [...repos].sort(
			(a, b) => b.metrics.commits - a.metrics.commits || a.name.localeCompare(b.name),
		),
		anomalies: repos.flatMap((r) => {
			const signals: FactorySignal[] = [];
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
type StreamWindow = (repo: FactoryRepo, stream: FactoryStreamName) => FactoryWindow;

function coversWindow(
	repo: FactoryRepo,
	stream: FactoryStreamName,
	windowOf: StreamWindow,
	from: number,
	to: number,
) {
	const window = windowOf(repo, stream);
	return (
		repo.coverage[stream].status === "complete" &&
		(repo.coverage[stream].completeWindows ?? [window]).some(
			(value) => Date.parse(value.since) <= from && Date.parse(value.until) >= to,
		)
	);
}

function sumFlow(days: Record<string, Flow>, from: number, to: number): Flow {
	const flow = emptyFlow();
	for (const [date, value] of Object.entries(days)) {
		const t = Date.parse(date);
		if (t < from || t >= to) continue;
		for (const k of FLOW_KEYS) flow[k] += value[k];
	}
	return flow;
}

function activityOf(r: FactoryRepo, windowOf: StreamWindow, midnight: number, asOf: number) {
	let last: string | undefined;
	for (const [date, value] of Object.entries(r.metrics.days))
		if (value.commits && date < isoDay(midnight + DAY_MS) && date > (last ?? "")) last = date;
	const known = {
		commits: coversWindow(r, "commits", windowOf, midnight - 30 * DAY_MS, midnight),
		issues: coversWindow(r, "issues", windowOf, midnight - 30 * DAY_MS, midnight),
		prs: coversWindow(r, "prs", windowOf, midnight - 30 * DAY_MS, midnight),
	};
	const current = (stream: "issues" | "prs") => coversWindow(r, stream, windowOf, asOf, asOf);
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
		agedIssues: current("issues") ? r.metrics.agedIssues : null,
		agedPrs: current("prs") ? r.metrics.agedPrs : null,
		known,
	};
}
export type RepoActivity = ReturnType<typeof activityOf>;

function periodSummary(
	repos: FactoryRepo[],
	windowOf: StreamWindow,
	midnight: number,
	length: Period,
	membershipComplete: boolean,
) {
	const since = midnight - length * DAY_MS;
	const previousSince = since - length * DAY_MS;
	const covered = (from: number, to: number) =>
		Object.fromEntries(
			PERIOD_STREAMS.map((stream) => [
				stream,
				membershipComplete &&
					repos.length > 0 &&
					repos.every((repo) => coversWindow(repo, stream, windowOf, from, to)),
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
		complete: covered(since, midnight),
		previousComplete: covered(previousSince, since),
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
function walkBack(
	days: BoardDay[],
	now: number | null,
	stream: "issues" | "prs",
	net: (d: BoardDay) => number,
) {
	const out: (number | null)[] = new Array(days.length).fill(null);
	let open = now;
	for (let i = days.length - 1; i >= 0 && open !== null && open >= 0; i--) {
		if (!days[i]?.complete[stream]) break;
		out[i] = open;
		open -= net(days[i] as BoardDay);
	}
	return out;
}

function addStock(days: BoardDay[], repos: FactoryRepo[], membershipComplete: boolean) {
	const exact = (stream: "issues" | "prs") =>
		membershipComplete &&
		repos.length > 0 &&
		repos.every((r) => r.coverage[stream].status === "complete");
	const sum = (key: "openIssues" | "openPrs") => repos.reduce((n, r) => n + r[key], 0);
	const openIssues = walkBack(
		days,
		exact("issues") ? sum("openIssues") : null,
		"issues",
		(d) => d.issueOpened - d.issueClosed,
	);
	const openPrs = walkBack(
		days,
		exact("prs") ? sum("openPrs") : null,
		"prs",
		(d) => d.prOpened - d.prMerged - d.prClosed,
	);
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
		const rolling = (stream: "commits" | "actions") =>
			i >= 6 && days.slice(i - 6, i + 1).every((day) => day.complete[stream]);
		return {
			...d,
			openIssues: openIssues[i] ?? null,
			openPrs: openPrs[i] ?? null,
			ciRate7: rolling("actions") && success + failure ? success / (success + failure) : null,
			activeRepos7: rolling("commits")
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
			done30:
				r.known.issues && r.known.prs ? r.periods[30].issueClosed + r.periods[30].prMerged : null,
		}))
		.filter((r) => r.total > 0)
		.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
	return {
		rows,
		openIssues: rows.reduce((n, r) => n + r.openIssues, 0),
		openPrs: rows.reduce((n, r) => n + r.openPrs, 0),
		aged: rows.every((r) => r.agedIssues !== null && r.agedPrs !== null)
			? rows.reduce((n, r) => n + (r.agedIssues ?? 0) + (r.agedPrs ?? 0), 0)
			: null,
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
		for (const d of r.manifests ?? []) {
			if (!packages.has(d.name)) packages.set(d.name, r.name);
			else if (packages.get(d.name) !== r.name) packages.set(d.name, null);
		}

	const edges = new Map<
		string,
		{ source: string; target: string; references: number; url: string }
	>();
	for (const r of repos)
		for (const d of r.dependencies) {
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
export function formatFactoryCount(n: number | null): string {
	return n === null ? "—" : n.toLocaleString("en-US");
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
export function factoryParams(
	current: URLSearchParams,
	key: string,
	value: string,
): URLSearchParams {
	const next = new URLSearchParams(current);
	if (value) next.set(key, value);
	else next.delete(key);
	if (key !== "page") next.delete("page");
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

export type FactorySignal = { repo: string; label: string; stream: FactoryStreamName };
export type FactorySignalGroup = { repo: string; signals: FactorySignal[] };

/** One row per repository keeps the inspection panel short; heaviest groups lead. */
/** Published daily series for a snapshot's selected membership, shared by trend charts. */
export function factoryDays(snapshot: FactoryViewSnapshot) {
	return factoryBoard(snapshot, snapshot.repos, snapshot.selectedRepos).days;
}

export function factorySignalGroups(anomalies: readonly FactorySignal[]): FactorySignalGroup[] {
	const byRepo = new Map<string, FactorySignal[]>();
	for (const signal of anomalies) {
		const signals = byRepo.get(signal.repo);
		if (signals) signals.push(signal);
		else byRepo.set(signal.repo, [signal]);
	}
	return [...byRepo.entries()]
		.map(([repo, signals]) => ({ repo, signals }))
		.sort((a, b) => b.signals.length - a.signals.length || a.repo.localeCompare(b.repo));
}

export const SIGNAL_PAGE_SIZE = 6;

export function factorySignalPage(groups: readonly FactorySignalGroup[], page: number) {
	const pages = Math.max(1, Math.ceil(groups.length / SIGNAL_PAGE_SIZE));
	const current = Math.min(pages, Math.max(1, page));
	return {
		rows: groups.slice((current - 1) * SIGNAL_PAGE_SIZE, current * SIGNAL_PAGE_SIZE),
		current,
		pages,
		groups: groups.length,
		signals: groups.reduce((n, group) => n + group.signals.length, 0),
	};
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
