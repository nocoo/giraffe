import type {
	FactoryRunResponse,
	FactoryRunView,
	RepoRefreshState,
	RunSelection,
	RunStatus,
	StepKind,
	StepStatus,
} from "../../lib/factory-run";
import { apiGet, apiPost } from "../lib/api";
import { ensureSession, getActiveAccountId } from "./session";

export const RUN_LABELS: Record<RunStatus, string> = {
	running: "进行中",
	paused: "已暂停",
	completed: "已完成",
	partial: "部分完成",
	failed: "失败",
	cancelled: "已取消",
};
export const STEP_LABELS: Record<StepKind, string> = {
	inventory: "仓库发现",
	restore: "恢复已有资源",
	contributions: "贡献日历",
	metadata: "仓库元数据",
	commits: "Commits",
	issues: "Issues",
	prs: "PRs",
	actions: "CI / Actions",
	releases: "Releases",
	alerts: "依赖告警",
	dependencies: "依赖证据",
	commit: "提交仓库快照",
	publish: "发布全局版本",
};
export const STEP_STATUS: Record<StepStatus, string> = {
	pending: "排队",
	running: "执行中",
	success: "成功",
	failed: "失败 / 覆盖不足",
	skipped: "跳过",
};
export const secondsUntil = (at: string | null, now: number) =>
	at ? Math.max(0, Math.ceil((Date.parse(at) - now) / 1000)) : 0;
export async function loadFactoryRuns(history = ""): Promise<FactoryRunResponse | null> {
	const account = await ensureSession();
	const response = await apiGet<FactoryRunResponse>(
		history ? `factory/runs?history=${encodeURIComponent(history)}` : "factory/runs",
	);
	return getActiveAccountId() === account && response.account_id === account ? response : null;
}
export async function startFactoryRun(
	input: RunSelection & { mode: "catalog" | "refresh" },
	requestKey: string,
) {
	const account = await ensureSession();
	const response = await apiPost<{ account_id: string; id: string }>("factory/runs", {
		...input,
		account_id: account,
		requestKey,
	});
	return getActiveAccountId() === account && response.account_id === account ? response : null;
}
export async function controlFactoryRun(id: string, action: "pause" | "resume" | "cancel") {
	const account = await ensureSession();
	const response = await apiPost<{ account_id: string; id: string }>(
		`factory/runs/${encodeURIComponent(id)}/control`,
		{ account_id: account, action },
	);
	return getActiveAccountId() === account && response.account_id === account ? response : null;
}
export function createRunPolling(options: {
	load: () => Promise<FactoryRunResponse | null>;
	onData: (state: FactoryRunResponse) => void;
	onError: (error: unknown) => void;
	hidden: () => boolean;
}) {
	let stopped = false;
	let flight: Promise<void> | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let failures = 0;
	const refresh = (): Promise<void> => {
		if (stopped) return Promise.resolve();
		if (flight) return flight;
		clearTimeout(timer);
		let active = false;
		flight = (async () => {
			try {
				const state = await options.load();
				if (!stopped && state) {
					options.onData(state);
					active = state.current?.status === "running";
				}
				failures = 0;
			} catch (error) {
				failures++;
				if (!stopped) options.onError(error);
			} finally {
				flight = null;
				if (!stopped)
					timer = setTimeout(
						() => void refresh(),
						options.hidden()
							? 60000
							: failures
								? Math.min(60000, 5000 * 2 ** failures)
								: active
									? 5000
									: 30000,
					);
			}
		})();
		return flight;
	};
	timer = setTimeout(() => void refresh(), 0);
	return {
		refresh,
		stop: () => {
			stopped = true;
			clearTimeout(timer);
		},
	};
}
export function runRepositoryRows(run: FactoryRunView | null, states: RepoRefreshState[]) {
	if (!run) return [];
	return run.repos.map((repo) => {
		const steps = run.steps.filter((s) => s.repo === repo);
		const completed = steps.filter((s) =>
			["success", "failed", "skipped"].includes(s.status),
		).length;
		const status: StepStatus = steps.some((s) => s.status === "running")
			? "running"
			: steps.some((s) => s.status === "failed")
				? "failed"
				: steps.every((s) => s.status === "skipped")
					? "skipped"
					: completed === steps.length
						? "success"
						: "pending";
		return {
			repo,
			steps,
			completed,
			total: steps.length,
			status,
			durationMs: steps.reduce((sum, s) => sum + s.durationMs, 0),
			pages: steps.reduce((sum, s) => sum + s.pages, 0),
			state: states.find((s) => s.repo === repo),
		};
	});
}
