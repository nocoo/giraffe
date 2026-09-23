import type {
	FactoryRunResponse,
	FactoryRunStep,
	FactoryRunView,
	RepoRefreshState,
	RunSelection,
	RunStatus,
	StepKind,
	StepStatus,
} from "../../lib/factory-run";
import { FACTORY_STREAMS, type FactorySnapshot } from "../../lib/factory-types";
import { apiGet, apiPost } from "../lib/api";
import { ensureSession, getActiveAccountId } from "./session";

export const RUN_LABELS: Record<RunStatus, string> = {
	running: "正在刷新",
	paused: "已暂停",
	completed: "已完成",
	partial: "已结束，有未完成项",
	failed: "刷新未成功",
	cancelled: "已取消",
};
export const STEP_LABELS: Record<StepKind, string> = {
	inventory: "获取仓库列表",
	restore: "读取已有数据",
	contributions: "账号贡献日历",
	metadata: "仓库信息",
	commits: "代码提交",
	issues: "Issue 记录",
	prs: "PR 记录",
	actions: "CI 运行记录",
	releases: "版本发布",
	alerts: "安全告警",
	dependencies: "依赖关系",
	commit: "保存仓库数据",
	snapshot: "页面数据",
	publish: "更新工厂页面",
};
const PAGE_LABELS: Record<string, string> = {
	repos: "仓库列表",
	issues: "Issues",
	prs: "Pull Requests",
	alerts: "安全告警",
	notifications: "通知",
	details: "仓库概览",
	actions: "CI 运行",
	traffic: "流量",
	security: "安全告警",
	releases: "版本发布",
	languages: "语言",
	contributors: "贡献者",
};
export function stepLabel(step: Pick<FactoryRunStep, "kind" | "resource">) {
	if (step.kind !== "snapshot") return STEP_LABELS[step.kind];
	const resource = step.resource ?? "";
	return `${resource.startsWith("repo:") ? "详情" : "全站"} · ${PAGE_LABELS[resource.split(":").at(-1) ?? ""] ?? "页面数据"}`;
}
export const STEP_STATUS: Record<StepStatus, string> = {
	pending: "等待执行",
	running: "正在获取",
	success: "已完成",
	failed: "未能完成",
	skipped: "已跳过",
};
export const formatRunDuration = (seconds: number) =>
	seconds >= 3600
		? `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`
		: seconds >= 60
			? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
			: `${seconds} 秒`;

const STEP_IMPACT: Record<StepKind, string> = {
	inventory: "无法确定完整的仓库范围，已有数据仍可查看。",
	restore: "部分历史数据可能尚未显示在页面上。",
	contributions: "账号贡献日历未更新；仓库提交日历单独计算。",
	metadata: "这个仓库本次无法更新；有历史数据时继续显示原来的数据。",
	commits: "提交数量和提交日历可能不完整。",
	issues: "Issue 数量和处理节奏可能不完整。",
	prs: "PR 合并数量、交付趋势和处理耗时可能不完整。",
	actions: "CI 次数和成功率可能不完整。",
	releases: "发布次数和交付趋势可能不完整。",
	alerts: "无法判断这些仓库是否有依赖漏洞，不能当成零告警。",
	dependencies: "依赖关系图可能缺少引用。",
	commit: "这个仓库的新数据尚未保存；有历史数据时继续保留。",
	snapshot: "对应页面保留上次保存的数据；首次采集未完成时暂不显示统计。",
	publish: "工厂总览尚未更新，继续显示上次统计；已经保存的其他页面数据不受影响。",
};

export function describeRunIssue(code: string | null, kind: StepKind, resource?: string) {
	const base = { impact: STEP_IMPACT[kind], settings: false };
	const label = stepLabel({ kind, ...(resource ? { resource } : {}) });
	const security = kind === "alerts" || resource === "alerts" || resource?.endsWith(":security");
	switch (code) {
		case "catalog_changed":
			return {
				...base,
				title: "仓库列表有变化",
				reason: "发现了不在本次计划内的新仓库。",
				action: "先点击「同步仓库列表」，再发起全站刷新。",
			};
		case "capability_missing":
			return {
				...base,
				title: `${label}缺少访问权限`,
				reason: "当前令牌未授权读取这类数据。",
				action:
					resource === "notifications"
						? "在账号设置中更新带有 notifications 权限的 PAT，再发起全站刷新。"
						: "在账号设置中检查 PAT 的 repo 权限，再发起全站刷新。",
				settings: true,
			};
		case "snapshot_unavailable":
		case "coverage_unavailable":
		case "github_forbidden":
		case "not_found":
		case "repository_unavailable":
			return {
				...base,
				title: `未能读取${label}`,
				reason: security
					? "GitHub 没有返回安全告警，可能是权限不足，或仓库未启用 Dependabot 告警。"
					: "没有读到可用数据，可能与访问权限、仓库设置或来源文件有关。",
				action: security
					? "检查仓库的 Dependabot alerts 设置，以及令牌的 repo / security_events 权限；调整后重新刷新这些仓库。"
					: "确认账号仍可访问仓库和对应功能，检查来源文件后重新刷新。",
				settings: true,
			};
		case "coverage_limited":
		case "snapshot_incomplete":
		case "github_response_too_large":
			return {
				...base,
				title: `${label}只获取了一部分`,
				reason: "数据没有全部读到，可能达到采集上限，或读取过程中失去访问权限。",
				action:
					"先检查 GitHub 权限；如果达到采集上限，重复刷新不会补齐，请到 GitHub 查看完整记录。",
			};
		case "github_unauthorized":
		case "account_missing":
			return {
				...base,
				title: "GitHub 账号需要重新连接",
				reason: "账号未连接，或访问令牌已失效。",
				impact: "刷新已暂停，已保存的进度和数据仍然保留。",
				action: "在账号设置中连接有效的 GitHub 令牌，然后点击「继续刷新」。",
				settings: true,
			};
		case "encryption_key_missing":
			return {
				...base,
				title: "暂时无法读取账号凭据",
				reason: "服务端缺少解密凭据所需的配置。",
				impact: "刷新已暂停，进度和已有数据保留。",
				action: "请维护者恢复加密配置，再点击「继续刷新」。",
			};
		case "github_rate_limited":
			return {
				...base,
				title: "正在等待 GitHub 请求额度恢复",
				reason: "GitHub 暂时限制了请求频率。",
				impact: "刷新暂缓，已获取的数据和进度保留。",
				action: "无需操作，额度恢复后会自动继续。可以关闭窗口。",
			};
		case "factory_capacity":
			return {
				...base,
				title: "本次刷新达到容量限制",
				reason: "存储用量或计划中的仓库数量达到上限。",
				impact: "刷新已暂停，已有数据和进度保留。",
				action:
					"统计仓库过多时可取消后减少统计仓库；全站清单或存储达到上限时，请维护者检查容量与历史保留。",
			};
		case "repository_cooldown":
			return {
				...base,
				title: "仓库统计刚刚刷新过",
				reason: "同一个仓库的工厂统计至少间隔 15 分钟更新。",
				impact: "本次统计沿用已有数据，页面数据仍会更新。",
				action: "等待 15 分钟间隔结束后，再更新这个仓库的工厂统计。",
			};
		case "coverage_regression_retained":
			return {
				...base,
				title: "已保留上次更完整的数据",
				reason: "这次获取的数据比上次少，系统保留了原来的记录。",
				impact: "页面继续使用上次的数据与统计时间范围。",
				action: "处理本次未能获取的数据后，再刷新这个仓库。",
			};
		case "repository_failed":
		case "run_failed":
			return {
				...base,
				title: "前面的步骤失败，本步骤已跳过",
				reason: "继续执行需要用到前面步骤的数据。",
				action: "先处理前面标记的问题，再重新刷新。",
			};
		default:
			return {
				...base,
				title: `${label}未完成`,
				reason: "这一步没有成功完成；现有记录无法确定更具体的原因。",
				action:
					"运行中会自动重试；若刷新已经结束，请重新刷新。再次失败时可把诊断代码提供给维护者。",
			};
	}
}

export function runIssues(run: FactoryRunView | null) {
	const groups = new Map<
		string,
		ReturnType<typeof describeRunIssue> & {
			key: string;
			kind: StepKind;
			code: string | null;
			repos: string[];
			count: number;
		}
	>();
	for (const step of run?.steps ?? []) {
		if (step.status !== "failed" && !step.error) continue;
		if (step.error === "repository_failed" || step.error === "run_failed") continue;
		const kind = step.error === "repository_cooldown" ? "metadata" : step.kind;
		const key = `${kind}:${step.resource?.split(":").at(-1) ?? ""}:${step.error}`;
		const group = groups.get(key) ?? {
			...describeRunIssue(step.error, kind, step.resource),
			key,
			kind,
			code: step.error,
			repos: [],
			count: 0,
		};
		group.count++;
		if (step.repo && !group.repos.includes(step.repo)) group.repos.push(step.repo);
		groups.set(key, group);
	}
	return [...groups.values()];
}

export function runStages(run: FactoryRunView) {
	const stages =
		run.mode === "catalog"
			? [
					{
						title: "获取仓库列表",
						steps: run.steps.filter((s) => s.kind === "inventory" || s.kind === "snapshot"),
					},
					{ title: "读取已有数据", steps: run.steps.filter((s) => s.kind === "restore") },
					{ title: "更新页面", steps: run.steps.filter((s) => s.kind === "publish") },
				]
			: [
					{ title: "账号贡献", steps: run.steps.filter((s) => s.kind === "contributions") },
					{
						title: "工厂统计",
						steps: run.steps.filter((s) => s.repo !== null && s.kind !== "snapshot"),
					},
					{
						title: run.steps.some((s) => s.resource === "repos") ? "全站页面" : "仓库页面",
						steps: run.steps.filter((s) => s.kind === "snapshot"),
					},
					{ title: "更新页面", steps: run.steps.filter((s) => s.kind === "publish") },
				];
	return stages
		.filter((stage) => stage.steps.length > 0)
		.map((stage) => ({
			...stage,
			total: stage.steps.length,
			completed: stage.steps.filter((s) => ["success", "failed", "skipped"].includes(s.status))
				.length,
			failed: stage.steps.filter((s) => s.status === "failed").length,
		}));
}

export function factoryDataHealth(snapshot: FactorySnapshot | null) {
	if (!snapshot)
		return {
			tone: "info",
			title: "还没有工厂数据",
			detail: "打开刷新控制台，同步仓库列表后开始第一次刷新。",
		};
	if (!snapshot.inventory.complete)
		return {
			tone: "warning",
			title: "仓库列表尚未获取完整",
			detail: "当前统计只包含已找到的仓库，可在刷新控制台继续同步。",
		};
	const required = FACTORY_STREAMS.filter((kind) => kind !== "alerts");
	const incomplete = snapshot.repos.filter((repo) =>
		required.some((kind) => repo.coverage[kind].status !== "complete"),
	);
	if (incomplete.length) {
		const missing = required
			.map((kind) => ({
				kind,
				count: incomplete.filter((r) => r.coverage[kind].status !== "complete").length,
			}))
			.filter((item) => item.count);
		return {
			tone: "warning",
			title: `${incomplete.length} 个仓库有数据未获取`,
			detail: `未完整获取：${missing
				.slice(0, 3)
				.map((item) => `${STEP_LABELS[item.kind]}（${item.count}）`)
				.join(
					"、",
				)}${missing.length > 3 ? ` 等 ${missing.length} 类数据` : ""}；缺失不代表零。${snapshot.publication?.mixed ? "各仓库更新时间不同。" : ""}`,
		};
	}
	if (!snapshot.contributionExcluded && snapshot.contributionStatus !== "complete")
		return {
			tone: "warning",
			title: "账号贡献日历尚未更新",
			detail: "仓库数据可用；账号贡献日历可能显示旧数据，或暂时为空。",
		};
	const optional = snapshot.repos.filter((repo) => repo.coverage.alerts.status !== "complete");
	if (optional.length)
		return {
			tone: "info",
			title: "工厂数据可用",
			detail: `可选安全告警未获取（${optional.length} 个仓库），安全状态未知。${snapshot.publication?.mixed ? "各仓库更新时间不同。" : ""}`,
		};
	if (snapshot.publication?.mixed)
		return {
			tone: "info",
			title: "数据可用，更新时间不一致",
			detail: "各仓库使用各自最近可用的数据，统计时间范围可能不同。",
		};
	return {
		tone: "success",
		title: "工厂数据完整",
		detail: `${snapshot.repos.length} 个仓库的 7 类数据均已获取；页面展示最近保存的结果。`,
	};
}
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
	return [...new Set([...run.repos, ...(run.siteRepos ?? [])])].map((repo) => {
		const steps = run.steps.filter((s) => s.repo === repo);
		const completed = steps.filter((s) =>
			["success", "failed", "skipped"].includes(s.status),
		).length;
		const status: StepStatus = steps.some((s) => s.status === "running")
			? "running"
			: steps.some((s) => s.status === "failed")
				? "failed"
				: steps.length > 0 && completed === steps.length
					? steps.some((s) => s.status === "skipped")
						? "skipped"
						: "success"
					: "pending";
		return {
			repo,
			steps,
			completed,
			total: steps.length,
			status,
			label: repositoryLabel(steps, status, run.status),
			durationMs: steps.reduce((sum, s) => sum + s.durationMs, 0),
			pages: steps.reduce((sum, s) => sum + s.pages, 0),
			state: states.find((s) => s.repo === repo),
		};
	});
}

function repositoryLabel(steps: FactoryRunStep[], status: StepStatus, runStatus: RunStatus) {
	if (
		["cancelled", "failed"].includes(runStatus) &&
		steps.some(
			(step) =>
				step.status === "pending" ||
				step.status === "running" ||
				step.error === "cancelled" ||
				step.error === "run_failed",
		)
	)
		return "未执行完";
	if (status === "failed")
		return steps.some((step) => step.kind === "commit" && step.status === "success")
			? "部分数据未获取"
			: "刷新未成功";
	if (status === "skipped" && steps.every((s) => s.error === "repository_cooldown"))
		return "刚刷新过，已跳过";
	if (status === "skipped" && steps.some((s) => s.error === "repository_cooldown"))
		return "页面已更新，统计沿用旧数据";
	if (runStatus === "paused" && steps.some((s) => s.startedAt && !s.finishedAt)) return "已暂停";
	return status === "success" ? "刷新完成" : STEP_STATUS[status];
}
export const publicationKey = (state: { account_id: string; publication: string | null }) =>
	`${state.account_id}:${state.publication ?? ""}`;
/** Skips re-reading the large published snapshot when the page already shows that publication. */
export function publishedReadNeeded(
	seen: string | undefined,
	state: { account_id: string; publication: string | null },
	shown: FactorySnapshot | null,
): boolean {
	if (seen === publicationKey(state)) return false;
	return !(
		shown?.account_id === state.account_id &&
		(state.publication === null || shown.publication?.runId === state.publication)
	);
}
