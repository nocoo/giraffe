import { aggregateFactory, emptyDay } from "../../lib/factory";
import {
	FACTORY_STREAMS,
	type FactoryCoverage,
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
	const days = [];
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
	const pulse = portfolioPulse(repos, snapshot.window, midnight, days);
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
		days,
		coverage,
		securityKnown: repos.filter((r) => r.coverage.alerts.status === "complete").length,
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
		pulse,
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
function portfolioPulse(
	repos: FactoryRepo[],
	fallback: FactoryWindow,
	midnight: number,
	days: {
		date: string;
		commits: number;
		prMerged: number;
		releases: number;
	}[],
) {
	const since = midnight - 7 * DAY_MS;
	const previousSince = midnight - 14 * DAY_MS;
	const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
	const inRange = (date: string, from: number, to: number) => {
		const t = Date.parse(date);
		return t >= from && t < to;
	};
	const recentDays = days.filter((d) => inRange(d.date, since, midnight));
	const previousDays = days.filter((d) => inRange(d.date, previousSince, since));
	const lastCommit = new Map<string, string>();
	const rows = repos.map((r) => {
		let recent = 0;
		let previous = 0;
		for (const [date, value] of Object.entries(r.metrics.days)) {
			if (inRange(date, since, midnight)) recent += value.commits;
			else if (inRange(date, previousSince, since)) previous += value.commits;
			if (value.commits && date > (lastCommit.get(r.name) ?? "")) lastCommit.set(r.name, date);
		}
		return { name: r.name, language: r.language, recent, previous };
	});
	const measured = rows.filter((_, i) => {
		const repo = repos[i];
		return repo !== undefined && hasFactoryMeasurement(repo, "commits");
	});
	const active = { week: 0, month: 0, dormant: 0, unknown: rows.length - measured.length };
	for (const row of measured) {
		const last = Date.parse(lastCommit.get(row.name) ?? "");
		if (last >= since) active.week++;
		else if (last >= midnight - 30 * DAY_MS) active.month++;
		else active.dormant++;
	}
	return {
		range: { since: iso(since), until: iso(midnight - DAY_MS) },
		commits: {
			recent: recentDays.reduce((n, d) => n + d.commits, 0),
			previous: previousDays.reduce((n, d) => n + d.commits, 0),
			// Whole days only: a window ending mid-day leaves that day's commits partial.
			complete:
				repos.length > 0 &&
				repos.every(
					(r) =>
						r.coverage.commits.status === "complete" &&
						Date.parse((r.observation?.window ?? fallback).since) <= previousSince &&
						Date.parse((r.observation?.window ?? fallback).until) >= midnight,
				),
		},
		prMerged: recentDays.reduce((n, d) => n + d.prMerged, 0),
		releases: recentDays.reduce((n, d) => n + d.releases, 0),
		active,
		movers: measured
			.filter((r) => r.recent > 0)
			.sort((a, b) => b.recent - a.recent || a.name.localeCompare(b.name))
			.slice(0, 6),
		cooling: measured
			.filter((r) => r.recent === 0 && r.previous > 0)
			.sort((a, b) => b.previous - a.previous || a.name.localeCompare(b.name))
			.slice(0, 6),
		lastCommit,
	};
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
