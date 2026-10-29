import { REFRESH_DIMENSIONS, type RefreshParams, type RefreshRun } from "../../lib/refresh-types";
import { apiGet, apiPost } from "../lib/api";
import { ApiError } from "../lib/errors";
import { DISPLAY_TIMEZONE } from "../lib/format";
import { cacheGeneration, ensureSession, getActiveAccountId } from "./session";

export const REFRESH_LABELS = {
	commits: "提交",
	issues: "Issues",
	prs: "PRs",
	actions: "CI / Actions",
	releases: "发布",
	alerts: "依赖告警",
};

export function defaultRefreshParams(now = new Date(), timezone = DISPLAY_TIMEZONE): RefreshParams {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		})
			.formatToParts(now)
			.map(({ type, value }) => [type, value]),
	);
	const previous = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
	previous.setUTCDate(previous.getUTCDate() - 1);
	const yesterday = previous.toISOString().slice(0, 10);
	return {
		since: yesterday,
		until: yesterday,
		timezone,
		dimensions: [...REFRESH_DIMENSIONS],
		force: false,
	};
}

export function refreshTimezone(
	params: RefreshParams,
	timezone: string,
	now = new Date(),
): RefreshParams {
	try {
		const { since, until } = defaultRefreshParams(now, timezone);
		return { ...params, since, until, timezone };
	} catch {
		return { ...params, timezone };
	}
}

export function validateRefreshParams(params: RefreshParams, now = new Date()): string | null {
	const validDay = (day: string) =>
		/^\d{4}-\d{2}-\d{2}$/.test(day) &&
		Number.isFinite(Date.parse(day)) &&
		new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
	if (!validDay(params.since) || !validDay(params.until) || params.since > params.until) {
		return "请填写有效日期，开始日期不能晚于结束日期。";
	}
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: params.timezone }).format();
	} catch {
		return "请填写有效的 IANA 时区，例如 Asia/Shanghai。";
	}
	if (params.until > defaultRefreshParams(now, params.timezone).until)
		return "只能刷新已结束的日期，不能选择今天或未来。";
	if ((Date.parse(params.until) - Date.parse(params.since)) / 86_400_000 >= 31)
		return "日期范围最多 31 个已结束的自然日。";
	if (
		!params.dimensions.length ||
		new Set(params.dimensions).size !== params.dimensions.length ||
		params.dimensions.some((dimension) => !REFRESH_DIMENSIONS.includes(dimension))
	)
		return "请选择非空且不重复的刷新维度。";
	if (
		params.repo !== undefined &&
		!/^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/.test(params.repo)
	) {
		return "仓库应为 owner/name。";
	}
	return null;
}

export function refreshActive(run: RefreshRun | null): boolean {
	return run?.status === "queued" || run?.status === "running";
}

export function refreshStatus(run: RefreshRun): string {
	return {
		queued: "排队中",
		running: "刷新中",
		completed: "已完成",
		partial: "部分完成",
		failed: "刷新失败",
		cancelled: "已取消",
	}[run.status];
}

export function refreshProgress(run: RefreshRun): string {
	if (run.phase === "account") return "A · 账号信息、贡献趋势与仓库清单";
	if (run.phase === "repos") return `B · 仓库串行刷新 ${run.completedRepos} / ${run.repos.length}`;
	return "刷新结束";
}

export function refreshError(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.code === "account_missing") return "请先在设置中连接 GitHub 账号。";
		if (error.code === "local_read_only") return "线上数据为只读，请切回 Local 后刷新。";
		if (error.code === "access_unauthorized") return "未通过 Access，请重新验证身份。";
		if (error.status === 404) return "刷新记录已不存在，请重新读取状态。";
		if (error.status === 409) return "刷新状态已变化，请重试读取状态后再操作。";
	}
	return "无法读取或启动刷新，请重试读取状态。";
}

type RefreshState = Readonly<{
	accountId: string | null;
	run: RefreshRun | null;
	loading: boolean;
	reading: boolean;
	starting: boolean;
	cancelling: boolean;
	available: boolean;
	ready: boolean;
	error: string | null;
}>;

export class RefreshViewModel {
	private state: RefreshState = {
		accountId: null,
		run: null,
		loading: true,
		reading: false,
		starting: false,
		cancelling: false,
		available: true,
		ready: false,
		error: null,
	};
	private generation = cacheGeneration();
	private listeners = new Set<() => void>();
	private dataListeners = new Set<() => void>();
	getSnapshot = (): RefreshState => this.state;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	subscribeData = (listener: () => void): (() => void) => {
		this.dataListeners.add(listener);
		return () => {
			this.dataListeners.delete(listener);
		};
	};
	accountChanged = (): void => {
		this.generation = cacheGeneration();
		this.update({
			accountId: getActiveAccountId(),
			run: null,
			loading: true,
			available: true,
			ready: false,
			error: null,
		});
		void this.read();
	};
	private update(next: Partial<RefreshState>): void {
		this.state = { ...this.state, ...next };
		for (const listener of this.listeners) listener();
	}
	private accept(run: RefreshRun | null): void {
		const previous = this.state.run;
		let next = run;
		if (run && previous?.id === run.id) {
			const snapshot =
				(refreshActive(run) && !refreshActive(previous)) ||
				Date.parse(run.updatedAt) < Date.parse(previous.updatedAt)
					? previous
					: run;
			next = { ...snapshot, cancelRequested: previous.cancelRequested || run.cancelRequested };
		}
		const changed =
			next &&
			!refreshActive(next) &&
			!this.state.loading &&
			(next.id !== previous?.id || refreshActive(previous));
		this.update({ run: next, error: null });
		if (changed) for (const listener of this.dataListeners) listener();
	}
	private async reject(error: unknown, generation: number): Promise<void> {
		if (cacheGeneration() !== generation) return;
		this.update({ error: refreshError(error), ready: false });
		if (
			error instanceof ApiError &&
			(error.code === "account_conflict" ||
				(error.status === 404 && error.code === "not_found" && refreshActive(this.state.run)))
		) {
			this.update({ run: null });
			try {
				await ensureSession();
			} catch (sessionError) {
				if (cacheGeneration() === generation && sessionError instanceof ApiError)
					this.update({ error: refreshError(sessionError) });
			}
		}
	}
	async read(): Promise<void> {
		if (this.state.reading || this.state.starting) return;
		this.update({ reading: true });
		let generation = cacheGeneration();
		try {
			const accountId = getActiveAccountId() ?? (await ensureSession());
			generation = cacheGeneration();
			if (this.generation !== generation || this.state.accountId !== accountId) {
				this.generation = generation;
				this.update({
					accountId,
					run: null,
					loading: true,
					available: true,
					ready: false,
					error: null,
				});
			}
			let run: RefreshRun | null;
			if (this.state.run && refreshActive(this.state.run)) {
				run = await apiGet<RefreshRun>(`refresh-runs/${encodeURIComponent(this.state.run.id)}`);
			} else {
				const result = await apiGet<{ items: RefreshRun[]; collectionAvailable: boolean }>(
					"refresh-runs",
				);
				if (cacheGeneration() !== generation) return;
				this.update({ available: result.collectionAvailable });
				run = result.items.find(refreshActive) ?? null;
				if (!run) {
					try {
						run = await apiGet<RefreshRun>("refresh-runs/latest");
					} catch (error) {
						if (!(error instanceof ApiError && error.code === "snapshot_missing")) throw error;
					}
				}
			}
			if (cacheGeneration() !== generation) return;
			if (run && run.accountId !== accountId)
				throw new ApiError(409, "account_conflict", "account changed");
			this.accept(run);
			this.update({ ready: true });
		} catch (error) {
			await this.reject(error, generation);
		} finally {
			this.update({ reading: false });
			if (cacheGeneration() === generation) this.update({ loading: false });
			else void this.read();
		}
	}
	async cancel(): Promise<void> {
		const run = this.state.run;
		if (
			!run ||
			!refreshActive(run) ||
			run.cancelRequested ||
			this.state.cancelling ||
			this.state.starting
		)
			return;
		const generation = cacheGeneration();
		this.update({ cancelling: true, error: null });
		try {
			const next = await apiPost<RefreshRun>(`refresh-runs/${encodeURIComponent(run.id)}/cancel`);
			if (generation !== cacheGeneration()) return;
			if (next.accountId !== this.state.accountId)
				throw new ApiError(409, "account_conflict", "account changed");
			const current = this.state.run;
			if (!current || current.id !== run.id) return;
			this.accept(next);
		} catch (error) {
			const current = this.state.run;
			if (current && current.id === run.id) await this.reject(error, generation);
		} finally {
			this.update({ cancelling: false });
			if (generation !== cacheGeneration()) void this.read();
		}
	}
	async start(params: RefreshParams): Promise<void> {
		if (
			this.state.loading ||
			this.state.reading ||
			this.state.starting ||
			!this.state.ready ||
			!this.state.available ||
			refreshActive(this.state.run)
		)
			return;
		if (this.generation !== cacheGeneration()) {
			await this.read();
			return;
		}
		const invalid = validateRefreshParams(params);
		if (invalid) {
			this.update({ error: invalid });
			return;
		}
		const generation = cacheGeneration();
		this.update({ starting: true, error: null });
		try {
			const run = await apiPost<RefreshRun>("refresh-runs", params);
			if (generation !== cacheGeneration()) return;
			if (run.accountId !== this.state.accountId)
				throw new ApiError(409, "account_conflict", "account changed");
			this.accept(run);
		} catch (error) {
			await this.reject(error, generation);
		} finally {
			this.update({ starting: false });
			if (generation !== cacheGeneration()) void this.read();
		}
	}
}
