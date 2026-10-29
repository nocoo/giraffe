import {
	REFRESH_DIMENSIONS,
	type RefreshDimension,
	type RefreshFailureDetail,
	type RefreshParams,
	type RefreshPartialReason,
	type RefreshRequestBreakdown,
	type RefreshRun,
} from "../../lib/refresh-types";
import { apiGet } from "../lib/api";
import { formatCount, formatPreciseDate } from "../lib/format";
import {
	REFRESH_LABELS,
	type RefreshViewModel,
	refreshActive,
	refreshError,
	refreshStatus,
} from "./refresh";
import { cacheGeneration, ensureSession, getActiveAccountId, subscribeSession } from "./session";

type RefreshPhaseTiming = {
	startedAt: string;
	finishedAt: string | null;
	attempts: number;
};

export type RefreshRunTimings = {
	queuedAt: string;
	a: (RefreshPhaseTiming & { reused: boolean }) | null;
	repos: (RefreshPhaseTiming & { repo: string })[];
};

export type RefreshRunWithTimings = RefreshRun & { timings?: RefreshRunTimings };

export type RefreshStepTiming = {
	startedAt: string;
	finishedAt: string | null;
	attempts: number;
	durationSeconds: number | null;
	durationLabel: string;
	interrupted: boolean;
};

export type RefreshRepoStatus =
	| "complete"
	| "partial"
	| "running"
	| "pending"
	| "skipped"
	| "interrupted"
	| "failed"
	| "unknown";
export type RefreshStepStatus = RefreshRepoStatus | "failed";
export type RefreshDimensionState =
	| "complete"
	| "partial"
	| "running"
	| "pending"
	| "skipped"
	| "interrupted"
	| "failed"
	| "unknown";

export type RefreshReason = {
	dimension: RefreshDimension | null;
	code: string;
	label: string;
	failures: RefreshFailureDetail[];
};

export type RefreshDimensionRow = {
	dimension: RefreshDimension;
	label: string;
	state: RefreshDimensionState;
	reasons: RefreshReason[];
};

export type RefreshRepoRow = {
	repo: string;
	index: number;
	status: RefreshRepoStatus;
	label: string;
	reasons: RefreshReason[];
	dimensions: RefreshDimensionRow[];
	timing: RefreshStepTiming | null;
};

export type RefreshAccountRow = {
	status: RefreshStepStatus;
	label: string;
	note: string | null;
	reasons: RefreshReason[];
	requests: { graphql: number | null; rest: number | null };
	timing: RefreshStepTiming | null;
};

export type RefreshRequestRow = {
	key: "a" | "b" | "total";
	label: string;
	graphql: number | null;
	rest: number | null;
	total: number | null;
};

export type RefreshProgress = {
	total: number;
	processed: number;
	complete: number;
	partial: number;
	unknown: number;
	pending: number;
	skipped: number;
	percent: number;
};

export type RefreshHistoryRow = {
	id: string;
	at: string;
	status: string;
	scope: string;
	duration: string;
	requests: string;
	problems: string;
	active: boolean;
};

const STATUS_LABELS: Record<RefreshStepStatus, string> = {
	complete: "已完成",
	partial: "部分完成",
	running: "进行中",
	pending: "待刷新",
	skipped: "未执行",
	interrupted: "已中断",
	failed: "失败",
	unknown: "结果未记录",
};

const DIMENSION_STATE_LABELS: Record<RefreshDimensionState, string> = {
	complete: "完整",
	partial: "部分",
	running: "读取中",
	pending: "待刷新",
	skipped: "未执行",
	interrupted: "已中断",
	failed: "未完成",
	unknown: "未记录",
};

const REASON_LABELS: Record<string, string> = {
	"catalog:incomplete": "仓库清单未完整获取",
	"contributions:unavailable": "贡献日历不可用",
	"issues:inventory_incomplete": "Issue 清单未完整",
	"prs:inventory_incomplete": "PR 清单未完整",
	"releases:latest_page_only": "仅获取到最新一页发布",
	"releases:incomplete_pagination": "发布分页信息缺失",
	"actions:github_error": "读取失败",
	"alerts:permission_denied": "无权限",
	"collection:partial": "该步骤只获取到部分数据",
	"dependencies:unavailable": "依赖分析不可用",
	repository_cooldown: "仓库刷新冷却中",
	github_rate_limited: "GitHub 速率限制",
	github_error: "GitHub 请求失败",
	network_error: "网络请求失败",
	refresh_schema_cutover: "旧版刷新记录已停止执行",
};

function finite(value: number | undefined | null): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sumCounts(counts: { graphql: number; rest: number } | undefined | null): number | null {
	const graphql = finite(counts?.graphql);
	const rest = finite(counts?.rest);
	return graphql === null || rest === null ? null : graphql + rest;
}

function knownDimension(value: string | null | undefined): RefreshDimension | null {
	return REFRESH_DIMENSIONS.includes(value as RefreshDimension)
		? (value as RefreshDimension)
		: null;
}

function reasonCode(code: string): { dimension: RefreshDimension | null; code: string } {
	const [head, ...rest] = code.split(":");
	const dimension = knownDimension(head);
	if (!dimension) return { dimension: null, code };
	return { dimension, code: rest.join(":") || "partial" };
}

function reasonLabel(dimension: RefreshDimension | null, code: string, source: string): string {
	const known = REASON_LABELS[source] ?? REASON_LABELS[code];
	if (known) return dimension ? `${REFRESH_LABELS[dimension]} · ${known}` : known;
	return dimension ? `${REFRESH_LABELS[dimension]} · ${code}` : code;
}

function failureSource(failure: RefreshFailureDetail): string {
	return failure.dimension ? `${failure.dimension}:${failure.code}` : failure.code;
}

export function refreshReasons(reason: RefreshPartialReason): RefreshReason[] {
	const parsed = reason.codes.map((source) => {
		const segment = reasonCode(source);
		return {
			...segment,
			label: reasonLabel(segment.dimension, segment.code, source),
			failures: (reason.failures ?? []).filter((failure) => failureSource(failure) === source),
		};
	});
	const extras = (reason.failures ?? [])
		.filter((failure) => !reason.codes.includes(failureSource(failure)))
		.map((failure) => {
			const segment = reasonCode(failureSource(failure));
			return {
				...segment,
				label: reasonLabel(segment.dimension, segment.code, failureSource(failure)),
				failures: [failure],
			};
		});
	return [...parsed, ...extras];
}

export function refreshFailureText(failure: RefreshFailureDetail): string {
	const parts: string[] = [];
	if (failure.httpStatus !== null) parts.push(`HTTP ${failure.httpStatus}`);
	const dimension = knownDimension(failure.dimension);
	if (failure.dimension) parts.push(dimension ? REFRESH_LABELS[dimension] : failure.dimension);
	if (failure.graphqlType) parts.push(`GraphQL ${failure.graphqlType}`);
	if (failure.graphqlPath?.length) parts.push(failure.graphqlPath.join("."));
	return parts.length ? parts.join(" · ") : failure.code;
}

export function refreshTimings(run: RefreshRun): RefreshRunTimings | undefined {
	return (run as RefreshRunWithTimings).timings;
}

export function refreshStepTiming(
	timing: RefreshPhaseTiming | undefined | null,
	now = Date.now(),
): RefreshStepTiming | null {
	if (!timing) return null;
	const start = Date.parse(timing.startedAt);
	const end = timing.finishedAt ? Date.parse(timing.finishedAt) : now;
	const duration =
		Number.isFinite(start) && Number.isFinite(end) && end >= start
			? Math.floor((end - start) / 1000)
			: null;
	return {
		startedAt: timing.startedAt,
		finishedAt: timing.finishedAt,
		attempts: timing.attempts,
		durationSeconds: duration,
		durationLabel: formatRefreshDuration(duration),
		interrupted: timing.finishedAt === null,
	};
}

export function refreshScopeLabel(run: RefreshRun): string {
	if (run.params.repo) return `单仓库 · ${run.params.repo}`;
	const scope = "星标仓库 + 上海当日新建且未观测的非 fork 仓库";
	return run.trigger === "scheduled" ? `每日自动 · ${scope}` : `手动 · ${scope}`;
}

export function refreshWindowLabel(run: RefreshRun): string {
	const { since, until, timezone } = run.params;
	return `${since} → ${until} · ${timezone}`;
}

export function refreshCurrentStep(run: RefreshRun): string {
	if (run.status === "queued") return "排队中 · A 账号信息";
	if (refreshActive(run) && run.phase === "account") return "A · 账号信息、贡献趋势与仓库清单";
	if (refreshActive(run) && run.phase === "repos") {
		const repo = run.repos[run.completedRepos];
		return `B · ${repo ?? "仓库"} · ${run.completedRepos + 1} / ${run.repos.length}`;
	}
	if (run.phase === "account") return "A 未完成";
	return `${refreshStatus(run)} · 刷新结束`;
}

function accountProcessed(run: RefreshRun): boolean {
	if (run.repos.length > 0) return true;
	if (run.phase === "done" && (run.status === "completed" || run.status === "partial")) return true;
	const timing = refreshTimings(run)?.a;
	return run.status === "cancelled" && Boolean(timing?.finishedAt);
}

function stepClock(run: RefreshRun, now: number): number {
	return refreshActive(run) ? now : Date.parse(run.finishedAt ?? run.updatedAt);
}

export function refreshProgressOf(run: RefreshRun): RefreshProgress {
	const total = 1 + run.repos.length;
	const processed = Math.min(total, (accountProcessed(run) ? 1 : 0) + run.completedRepos);
	const accountPartial =
		accountProcessed(run) && run.partialReasons?.some((reason) => reason.repo === null);
	const partialRepos = new Set(
		(run.partialReasons ?? []).flatMap((reason) =>
			reason.repo && run.repos.slice(0, run.completedRepos).includes(reason.repo)
				? [reason.repo]
				: [],
		),
	).size;
	const partial = Math.min(processed, (accountPartial ? 1 : 0) + partialRepos);
	const unknown = run.partialReasons ? 0 : processed;
	const terminal = !refreshActive(run);
	const skipped = terminal ? total - processed : 0;
	const pending = terminal ? 0 : total - processed;
	return {
		total,
		processed,
		complete: Math.max(0, processed - partial - unknown),
		partial,
		unknown,
		pending,
		skipped,
		percent: Math.round((processed / total) * 100),
	};
}

export function refreshAccountRow(run: RefreshRun, now = Date.now()): RefreshAccountRow {
	const timing = refreshStepTiming(refreshTimings(run)?.a, stepClock(run, now));
	const reasons = (run.partialReasons ?? [])
		.filter((reason) => reason.repo === null)
		.flatMap(refreshReasons);
	let status: RefreshStepStatus;
	if (run.status === "failed" && run.repos.length === 0) status = "failed";
	else if (reasons.length) status = "partial";
	else if (accountProcessed(run)) status = run.partialReasons ? "complete" : "unknown";
	else if (refreshActive(run)) status = run.status === "queued" ? "pending" : "running";
	else if (run.status === "cancelled" && timing?.finishedAt) status = "complete";
	else if (run.status === "cancelled" && timing?.startedAt) status = "interrupted";
	else status = "skipped";
	return {
		status,
		label: STATUS_LABELS[status],
		note: run.aReused ? "复用当日账号数据，0 次上游请求" : null,
		reasons,
		requests: {
			graphql: finite(run.requestBreakdown?.a?.graphql),
			rest: finite(run.requestBreakdown?.a?.rest),
		},
		timing,
	};
}

function repoStatus(
	run: RefreshRun,
	index: number,
	timing: RefreshStepTiming | null,
): RefreshRepoStatus {
	const done = index < run.completedRepos;
	if (done)
		return !run.partialReasons
			? "unknown"
			: run.partialReasons.some((reason) => reason.repo === run.repos[index])
				? "partial"
				: "complete";
	if (refreshActive(run) && run.phase === "repos" && index === run.completedRepos) return "running";
	if (refreshActive(run)) return "pending";
	const attempted =
		Boolean(timing?.startedAt) ||
		Boolean(run.partialReasons?.some((reason) => reason.repo === run.repos[index]));
	if (run.status === "failed" && attempted) return "failed";
	if (run.status === "cancelled" && attempted) return "interrupted";
	return "skipped";
}

function dimensionState(
	status: RefreshRepoStatus,
	reasons: RefreshReason[],
	dimensionReasons: RefreshReason[],
): RefreshDimensionState {
	if (status === "complete") return "complete";
	if (status === "partial")
		return dimensionReasons.length || reasons.some((reason) => reason.dimension === null)
			? "partial"
			: "complete";
	return status;
}

export function refreshRepoRows(run: RefreshRun, now = Date.now()): RefreshRepoRow[] {
	const timings = refreshTimings(run)?.repos ?? [];
	return run.repos.map((repo, index) => {
		const timing = refreshStepTiming(
			timings.find((entry) => entry.repo === repo),
			stepClock(run, now),
		);
		const status = repoStatus(run, index, timing);
		const reasons = (run.partialReasons ?? [])
			.filter((reason) => reason.repo === repo)
			.flatMap(refreshReasons);
		return {
			repo,
			index,
			status,
			label: STATUS_LABELS[status],
			reasons,
			timing,
			dimensions: run.params.dimensions.map((dimension) => {
				const dimensionReasons = reasons.filter((reason) => reason.dimension === dimension);
				const state = dimensionState(status, reasons, dimensionReasons);
				return {
					dimension,
					label: `${REFRESH_LABELS[dimension]} · ${DIMENSION_STATE_LABELS[state]}`,
					state,
					reasons: dimensionReasons,
				};
			}),
		};
	});
}

export function refreshRequestRows(run: RefreshRun): RefreshRequestRow[] {
	const breakdown = run.requestBreakdown as RefreshRequestBreakdown | undefined;
	return [
		{
			key: "a",
			label: "A · 账号",
			graphql: finite(breakdown?.a?.graphql),
			rest: finite(breakdown?.a?.rest),
			total: sumCounts(breakdown?.a),
		},
		{
			key: "b",
			label: "B · 仓库",
			graphql: finite(breakdown?.b?.graphql),
			rest: finite(breakdown?.b?.rest),
			total: sumCounts(breakdown?.b),
		},
		{
			key: "total",
			label: "合计",
			graphql: finite(breakdown?.graphql),
			rest: finite(breakdown?.rest),
			total: finite(breakdown?.total) ?? finite(run.requests),
		},
	];
}

export function refreshRequestNote(run: RefreshRun): string | null {
	const breakdown = run.requestBreakdown as RefreshRequestBreakdown | undefined;
	if (!breakdown)
		return `这次运行只保存了共 ${formatCount(run.requests)} 次请求，没有记录 A/B 拆分。`;
	if (!breakdown.a || !breakdown.b)
		return "这次运行没有记录完整的 A/B 拆分，仅显示可确认的请求总数。";
	return null;
}

export function refreshDuration(run: RefreshRun, now = Date.now()): number | null {
	const start = Date.parse(run.createdAt);
	const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
	return Math.floor((end - start) / 1000);
}

export function formatRefreshDuration(seconds: number | null): string {
	if (seconds === null || !Number.isFinite(seconds)) return "—";
	if (seconds >= 3600)
		return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`;
	if (seconds >= 60) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
	return `${seconds} 秒`;
}

export function refreshDurationLabel(run: RefreshRun, now = Date.now()): string {
	return formatRefreshDuration(refreshDuration(run, now));
}

export function refreshTimingRows(
	run: RefreshRun,
	now = Date.now(),
): { label: string; value: string }[] {
	const timings = refreshTimings(run);
	const rows = [
		{ label: "开始", value: formatPreciseDate(timings?.queuedAt ?? run.createdAt) },
		{ label: "最后响应", value: formatPreciseDate(run.updatedAt) },
	];
	if (timings?.a?.startedAt)
		rows.push({ label: "A 开始", value: formatPreciseDate(timings.a.startedAt) });
	if (run.finishedAt) rows.push({ label: "结束", value: formatPreciseDate(run.finishedAt) });
	rows.push({ label: "耗时", value: refreshDurationLabel(run, now) });
	return rows;
}

export function refreshProblemRepos(run: RefreshRun): string[] {
	const repos = [
		...new Set((run.partialReasons ?? []).flatMap((reason) => (reason.repo ? [reason.repo] : []))),
	];
	return run.partialReasons?.some((reason) => reason.repo === null) ? ["账号", ...repos] : repos;
}

export function refreshHistoryRows(runs: RefreshRun[], now = Date.now()): RefreshHistoryRow[] {
	return runs.map((run) => {
		const problems = refreshProblemRepos(run);
		return {
			id: run.id,
			at: formatPreciseDate(run.createdAt),
			status: refreshStatus(run),
			scope: refreshScopeLabel(run),
			duration: refreshDurationLabel(run, now),
			requests: formatCount(run.requests),
			problems: !run.partialReasons ? "未记录" : problems.length ? problems.join("、") : "—",
			active: refreshActive(run),
		};
	});
}

export function canCancelRefresh(run: RefreshRun | null): boolean {
	return run !== null && refreshActive(run) && !run.cancelRequested;
}

export function mergeRefreshRuns(items: RefreshRun[], current: RefreshRun | null): RefreshRun[] {
	if (!current) return items;
	const index = items.findIndex((item) => item.id === current.id);
	if (index < 0) return [current, ...items];
	return items.map((item, position) => (position === index ? current : item));
}

export type RefreshLiveState = ReturnType<RefreshViewModel["getSnapshot"]>;

export type RefreshLiveModel = {
	getSnapshot: () => RefreshLiveState;
	subscribe: (listener: () => void) => () => void;
	subscribeData: (listener: () => void) => () => void;
	read: () => Promise<void>;
	start: (params: RefreshParams) => Promise<void>;
	cancel: () => Promise<void>;
};

export type RefreshCenterState = {
	accountId: string | null;
	live: RefreshLiveState;
	history: RefreshRun[];
	historyAccount: string | null;
	runs: RefreshRun[];
	selectedId: string;
	selected: RefreshRun | null;
	loading: boolean;
	error: string | null;
	now: number;
};

type CenterData = Pick<
	RefreshCenterState,
	"history" | "historyAccount" | "selectedId" | "loading" | "error" | "now"
>;

export class RefreshCenterViewModel {
	private data: CenterData;
	private state: RefreshCenterState;
	private listeners = new Set<() => void>();
	private reading = false;
	private pending = false;
	private disposed = false;
	private readonly unsubscribes: (() => void)[];
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly liveModel: RefreshLiveModel,
		now = Date.now(),
	) {
		this.data = {
			history: [],
			historyAccount: null,
			selectedId: "",
			loading: true,
			error: null,
			now,
		};
		this.state = this.compose(this.data);
		this.unsubscribes = [
			liveModel.subscribe(() => this.sync()),
			liveModel.subscribeData(() => void this.load()),
			subscribeSession(() => {
				this.data = {
					...this.data,
					history: [],
					historyAccount: null,
					selectedId: "",
				};
				this.update();
				void this.load();
			}),
		];
		this.timer = setInterval(() => {
			if (!this.disposed && refreshActive(this.liveModel.getSnapshot().run))
				this.updateData({ now: Date.now() });
		}, 1000);
		void this.load();
	}

	getSnapshot = (): RefreshCenterState => this.state;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	private compose(data: CenterData): RefreshCenterState {
		const source = this.liveModel.getSnapshot();
		const live =
			source.run && source.run.accountId !== source.accountId ? { ...source, run: null } : source;
		const history =
			live.accountId !== null &&
			data.historyAccount !== null &&
			live.accountId !== data.historyAccount
				? []
				: data.history;
		const runs = mergeRefreshRuns(history, live.run);
		const selected = data.selectedId
			? (runs.find((run) => run.id === data.selectedId) ?? null)
			: (live.run ?? runs[0] ?? null);
		return { ...data, accountId: live.accountId, live, runs, selected };
	}
	private update(): void {
		if (this.disposed) return;
		this.state = this.compose(this.data);
		for (const listener of this.listeners) listener();
	}
	private updateData(next: Partial<CenterData>): void {
		this.data = { ...this.data, ...next };
		this.update();
	}
	private sync(): void {
		const live = this.liveModel.getSnapshot();
		if (live.accountId !== this.state.accountId) {
			this.data = { ...this.data, selectedId: "" };
			if (
				live.accountId !== null &&
				this.data.historyAccount !== null &&
				live.accountId !== this.data.historyAccount
			)
				this.data = { ...this.data, history: [], historyAccount: null };
			this.update();
			return;
		}
		this.update();
	}
	async load(): Promise<void> {
		if (this.disposed) return;
		if (this.reading) {
			this.pending = true;
			return;
		}
		this.reading = true;
		this.updateData({ loading: true });
		const generation = cacheGeneration();
		const accountId = getActiveAccountId() ?? this.liveModel.getSnapshot().accountId;
		try {
			const body = await apiGet<{ items: RefreshRun[]; collectionAvailable: boolean }>(
				"refresh-runs",
			);
			if (generation !== cacheGeneration() || this.disposed) return;
			if (body.items.some((run) => run.accountId !== accountId)) {
				this.updateData({
					history: [],
					historyAccount: null,
					error: "活动账号已变化，正在重新读取账号，请重试。",
				});
				await ensureSession();
				return;
			}
			this.updateData({
				history: body.items,
				historyAccount: accountId,
				error: null,
			});
		} catch (error) {
			if (generation !== cacheGeneration() || this.disposed) return;
			this.updateData({ error: refreshError(error) });
		} finally {
			this.reading = false;
			if (generation === cacheGeneration() && !this.disposed) this.updateData({ loading: false });
			if (this.pending) {
				this.pending = false;
				void this.load();
			}
		}
	}
	select(id: string): void {
		this.updateData({ selectedId: id });
	}
	async start(params: RefreshParams): Promise<void> {
		await this.liveModel.start(params);
		this.select("");
	}
	async cancel(): Promise<void> {
		await this.liveModel.cancel();
	}
	async refreshAll(): Promise<void> {
		await Promise.all([this.liveModel.read(), this.load()]);
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.timer);
		for (const unsubscribe of this.unsubscribes) unsubscribe();
		this.listeners.clear();
	}
}
