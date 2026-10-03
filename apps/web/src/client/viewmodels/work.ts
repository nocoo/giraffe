import type { Resource } from "@nocoo/giraffe-agent/contracts";
import {
	cronStatusSchema,
	type RepositoryProgress,
	workRunSchema,
} from "@nocoo/giraffe-agent/work-contracts";
import { apiGet, apiPost, apiWrite } from "../lib/api";
import { ApiError } from "../lib/errors";
import { ensureSession, getActiveAccountId } from "./session";

export type WorkData = {
	account_id: string;
	jobs: Resource[];
	cron: Resource | null;
	control: Resource | null;
};
export function workBoard(data: WorkData, now: number) {
	const errors: string[] = [];
	const jobs = data.jobs
		.flatMap((row) => {
			const parsed = workRunSchema.safeParse(row.payload);
			if (!parsed.success || row.type !== "work-run" || row.account_id !== data.account_id) {
				errors.push("部分周期记录无效，未展示");
				return [];
			}
			return [{ ...row, ...parsed.data }];
		})
		.sort(
			(left, right) =>
				right.created_at.localeCompare(left.created_at) ||
				right.updatedAt.localeCompare(left.updatedAt),
		);
	const parsed = cronStatusSchema.safeParse(data.cron?.payload);
	const cron =
		parsed.success && data.cron?.account_id === data.account_id && data.cron.type === "work-cron"
			? parsed.data
			: null;
	if (data.cron && !cron) errors.push("定时器状态无效");
	const age = cron ? now - Date.parse(cron.lastSeenAt) : Infinity;
	const online = !!cron && age >= -60000 && age <= 45000 && cron.state !== "offline";
	const desiredPaused =
		data.control?.account_id === data.account_id && typeof data.control.payload.paused === "boolean"
			? data.control.payload.paused
			: (cron?.paused ?? false);
	return {
		jobs,
		cron,
		online,
		desiredPaused,
		pausePending: !!cron && desiredPaused !== cron.paused,
		errors,
	};
}

const phaseLabels = ["准备", "修复 / 检查", "独立审查", "发布", "跟进"];
const repositoryStates: Record<string, { label: string; phase: number }> = {
	preparing: { label: "准备中", phase: 0 },
	fixing: { label: "修复中", phase: 1 },
	checking: { label: "检查中", phase: 1 },
	reviewing: { label: "审查中", phase: 2 },
	signed_off: { label: "审查通过，待发布", phase: 3 },
	locally_reviewed: { label: "本地审查通过，未推送", phase: 2 },
	reviewed_no_change: { label: "审查完成，无需改动", phase: 2 },
	pushed: { label: "已推送", phase: 3 },
	deferred: { label: "任务暂缓", phase: 1 },
	exhausted: { label: "达到轮次上限，未推送", phase: 2 },
	blocked: { label: "仓库受阻", phase: 1 },
};
const outcomeLabels: Record<string, string> = {
	committed: "已提交",
	reviewed_no_change: "审查后无需改动",
	deferred: "暂缓",
	C: "已提交",
	N: "审查后无需改动",
	D: "暂缓",
};
const followupLabels = {
	pending: "等待验证",
	passed: "验证通过",
	failed: "验证失败，需关注",
	timeout: "验证超时，需关注",
};
const taskLabels: Record<string, string> = { dependency: "依赖升级", pr: "清理 PR", ci: "CI 故障" };
function reasonLabel(value: string) {
	const text = value.slice(0, 500).toLowerCase();
	if (/version|upgrade|版本|升级/.test(text)) return "版本升级需确认";
	if (/dirty|existing changes|已有改动|未提交/.test(text)) return "工作区已有改动";
	if (/test|check|coverage|lint|检查|测试|覆盖率/.test(text)) return "检查未通过";
	if (/review|finding|审查/.test(text)) return "审查待修正";
	if (/evidence|snapshot|source|证据|来源|快照/.test(text)) return "来源不足";
	if (/connect|transport|network|连接|网络/.test(text)) return "连接待恢复";
	return "需人工查看";
}
function modelLabel(value: string | undefined) {
	return value &&
		/^[a-z][a-z0-9.-]{0,79}( \/ (off|none|minimal|low|medium|high|xhigh|max))?$/i.test(value)
		? value
		: "模型未上报";
}
function repositoryView(name: string, progress: RepositoryProgress) {
	const state = repositoryStates[progress.status] ?? { label: "状态待确认", phase: -1 };
	const tasks = progress.tasks.map((task, index) => {
		const match = /^(dependency|pr|ci):([1-9]\d{0,15})$/.exec(task);
		const disposition = progress.dispositions?.find((item) => item.task === task);
		return {
			key: `task-${index}`,
			label: match ? `${taskLabels[match[1] as string]} #${match[2]}` : "任务详情未上报",
			outcome:
				outcomeLabels[disposition?.outcome ?? progress.dispositionOutcomes?.[index] ?? ""] ??
				"待处理",
			reason: disposition?.reason
				? disposition.outcome === "deferred"
					? reasonLabel(disposition.reason)
					: disposition.outcome === "reviewed_no_change"
						? "无需改动说明已记录"
						: "提交说明已记录"
				: null,
		};
	});
	return {
		name: /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(name) ? name : "仓库名称未验证",
		status: progress.followup
			? `已推送 · ${followupLabels[progress.followup.outcome]}`
			: state.label,
		phase: progress.followup ? 4 : state.phase,
		phases: phaseLabels,
		tasks,
		round: progress.round,
		worker: progress.worker === null ? "待分配" : "已分配",
		reviewer: progress.reviewer === null ? "待分配" : "独立会话",
		workerModel: modelLabel(progress.workerModel),
		reviewerModel: modelLabel(progress.reviewerModel),
		findings: progress.findings.length
			? `${progress.findings.length} 项审查发现，详述不在此展示`
			: "没有上报审查发现",
		findingCategories: [...new Set(progress.findings.map(reasonLabel))],
		detailsOmitted: !!progress.detailsOmitted,
		followup: progress.followup
			? `${followupLabels[progress.followup.outcome]} · ${progress.followup.checks}/3 次`
			: "尚无发布后验证记录",
		pushed: progress.status === "pushed" || !!progress.followup,
		following: progress.followup?.outcome === "pending" && progress.followup.checks < 3,
	};
}

const eventRules = [
	{
		prefix: "[主控] API 快照：",
		category: "观察",
		label: "已读取 Web 仓库快照",
		node: "observations",
	},
	{
		prefix: "[主控] 本周期无可执行仓库",
		category: "调度",
		label: "没有可执行仓库，保留分析结果",
		node: "coordinator",
	},
	{ prefix: "[Jev 优先级]", category: "决策", label: "Jev 已记录候选优先级评估", node: "jev" },
	{ prefix: "[会话 ", category: "会话", label: "已记录模型会话", node: "coordinator" },
	{ prefix: "[候选]", category: "准备", label: "已检查候选工作区", node: "preparation" },
	{ prefix: "[主控调度]", category: "调度", label: "已安排仓库任务", node: "coordinator" },
	{ prefix: "[准备交接 ", category: "准备", label: "已记录工作区准备交接", node: "preparation" },
	{ prefix: "[Worker 交接 ", category: "执行", label: "已记录 Worker 交接", node: "worker" },
	{ prefix: "[独立审查 ", category: "审查", label: "已记录独立审查结果", node: "reviewer" },
	{ prefix: "[仓库进度]", category: "执行", label: "仓库进度已更新", node: "worker" },
	{
		prefix: "[任务终态]",
		category: "调度",
		label: "保留已处理任务，不重复执行",
		node: "coordinator",
	},
	{ prefix: "[本地完成]", category: "审查", label: "本地验证完成，未推送", node: "reviewer" },
	{ prefix: "[发布恢复完成]", category: "发布", label: "已确认持久化发布记录", node: "publish" },
	{ prefix: "[主控发布]", category: "发布", label: "主机已记录发布结果", node: "publish" },
	{
		prefix: "[Issue 已关闭]",
		category: "发布",
		label: "已记录完成任务的关闭结果",
		node: "publish",
	},
	{ prefix: "[推送跟进]", category: "跟进", label: "已读取发布后检查证据", node: "followup" },
	{ prefix: "[工作区阻塞]", category: "关注", label: "工作区准备受阻", node: "preparation" },
	{ prefix: "[仓库阻塞]", category: "关注", label: "仓库任务受阻，未获发布许可", node: "worker" },
	{
		prefix: "[修复周期失败]",
		category: "关注",
		label: "本周期执行失败，需关注",
		node: "coordinator",
	},
	{ prefix: "[分析关注]", category: "关注", label: "分析或报告交付需关注", node: "analysts" },
	{
		prefix: "[分析证据缺失]",
		category: "关注",
		label: "分析来源证据缺失，结论未知",
		node: "analysts",
	},
] as const;
function presentEvent(raw: string) {
	const event = raw.slice(0, 1000);
	const analyst = /^\[常驻 (issues|prs|ci|cd) (会话 \d{1,10}|失败)\]/.exec(event);
	if (analyst)
		return {
			category: "分析",
			label: `${({ issues: "Issue", prs: "PR", ci: "CI", cd: "CD" } as Record<string, string>)[analyst[1] as string]} 分析${analyst[2] === "失败" ? "需关注" : "已记录"}`,
			node: "analysts",
			domain: analyst[1],
		};
	const rule = eventRules.find((item) => event.startsWith(item.prefix));
	if (!rule) return null;
	const counts =
		rule.node === "observations"
			? /^\[主控\] API 快照：(\d{1,6}) 个自有仓库，(\d{1,6}) 条 Issue，(\d{1,6}) 条 PR/.exec(event)
			: null;
	return {
		category: rule.category,
		label: counts
			? `已读取 ${counts[1]} 个仓库 · ${counts[2]} 条 Issue · ${counts[3]} 条 PR`
			: rule.label,
		node: rule.node,
		domain: undefined,
	};
}
const topology = [
	{
		id: "observations",
		title: "Web 观察",
		subtitle: "仓库快照",
		tone: "blue",
		responsibility: "读取已保存的 Web 快照；不把分析时间当作源数据的新鲜度。",
	},
	{
		id: "coordinator",
		title: "统一主控",
		subtitle: "授权与任务交接",
		tone: "purple",
		responsibility: "协调授权范围、任务次序与交接，保留既有改动和进度。",
	},
	{
		id: "jev",
		title: "Jev",
		subtitle: "候选优先级",
		tone: "amber",
		responsibility: "分批评估候选优先级；不能扩大主机授权范围。",
	},
	{
		id: "preparation",
		title: "工作区准备",
		subtitle: "基线与证据核验",
		tone: "teal",
		responsibility: "检查工作区和基线，准备执行证据，不丢弃已有改动。",
	},
	{
		id: "worker",
		title: "执行者 Worker",
		subtitle: "修复与检查",
		tone: "blue",
		responsibility: "执行受限任务、正常检查和原子提交；不能自行推送。",
	},
	{
		id: "reviewer",
		title: "独立审查 Reviewer",
		subtitle: "独立只读审查",
		tone: "purple",
		responsibility: "独立审查待发布的全部提交；修复、检查、审查最多 20 轮。",
	},
	{
		id: "publish",
		title: "主机发布",
		subtitle: "精确提交推送",
		tone: "teal",
		responsibility: "精确提交获审查通过后才由主机推送；不合并 PR、不发布版本、不部署。",
	},
	{
		id: "followup",
		title: "发布后验证",
		subtitle: "提交级 Actions 证据",
		tone: "amber",
		responsibility: "读取精确发布提交的 Actions 证据，最多三次；已推送不等于验证通过。",
	},
	{
		id: "analysts",
		title: "四域分析",
		subtitle: "四域常驻分析",
		tone: "purple",
		responsibility: "Issue、PR、CI、CD 四个独立分析会话，保留报告；分析报告不是代码修复验收。",
	},
];
export function workExperience(data: WorkData, now: number, selectedId: string | null) {
	const board = workBoard(data, now);
	const runs = board.jobs.map((job) => {
		const current =
			board.online &&
			board.cron?.state === "running" &&
			job.status === "running" &&
			job.occurrence === board.cron.activeOccurrence;
		const repositories = Object.entries(job.repositories).map(([name, progress], position) => ({
			...repositoryView(name, progress),
			key: `repository-${position}`,
		}));
		const activities = job.events.flatMap((event, position) => {
			const item = presentEvent(event);
			return item ? [{ ...item, key: `activity-${position}`, order: position + 1 }] : [];
		});
		const status =
			job.status === "running"
				? current
					? "进行中"
					: "执行状态待确认"
				: ((
						{
							completed: "已完成",
							attention: "需关注",
							blocked: "已阻塞",
							failed: "执行失败",
						} as Record<string, string>
					)[job.status] ?? "状态待确认");
		return {
			id: job.id,
			current,
			status,
			createdAt: job.created_at,
			updatedAt: job.updatedAt,
			repositories,
			activities,
			omittedEvents: job.events.length - activities.length,
			analysisAttention: !!job.analysisAttention,
			empty: repositories.length
				? ""
				: current
					? "正在评估候选与分析证据，尚未选择执行仓库。"
					: job.status === "completed"
						? "本周期没有可执行仓库，分析记录仍可查看。"
						: "尚无仓库执行记录；不能据此判断执行成功。",
		};
	});
	const selected =
		runs.find((run) => run.id === selectedId) ?? runs.find((run) => run.current) ?? runs[0] ?? null;
	const nodes = topology.map((node) => {
		const observed =
			(selected?.activities.some((activity) => activity.node === node.id) ?? false) ||
			(selected?.repositories.some((repo) =>
				node.id === "worker"
					? repo.worker === "已分配"
					: node.id === "reviewer"
						? repo.reviewer === "独立会话"
						: node.id === "publish"
							? repo.pushed
							: node.id === "followup"
								? repo.phase === 4
								: false,
			) ??
				false);
		const phase = (
			{ preparation: 0, worker: 1, reviewer: 2, publish: 3, followup: 4 } as Record<string, number>
		)[node.id];
		const active =
			!!selected?.current &&
			phase !== undefined &&
			selected.repositories.some(
				(repo) =>
					repo.phase === phase &&
					(["准备中", "修复中", "检查中", "审查中"].includes(repo.status) ||
						(node.id === "followup" && repo.following)),
			);
		const models = [
			...new Set(
				selected?.repositories.map((repo) =>
					node.id === "worker"
						? repo.workerModel
						: node.id === "reviewer"
							? repo.reviewerModel
							: "模型未上报",
				),
			),
		];
		return {
			...node,
			state: active
				? node.id === "followup"
					? "跟进中"
					: "进行中"
				: observed
					? "有活动记录"
					: "未观察到执行",
			models: models.filter((model) => model !== "模型未上报"),
		};
	});
	const canPause =
		!!board.cron &&
		data.cron?.id === "work-cron" &&
		(!data.control ||
			(data.control.id === "work-control" &&
				data.control.type === "work-control" &&
				data.control.account_id === data.account_id &&
				typeof data.control.payload.paused === "boolean"));
	return {
		runs,
		selected,
		nodes,
		analysts: ["issues", "prs", "ci", "cd"].map((domain) => ({
			id: domain,
			label: ({ issues: "Issue", prs: "PR", ci: "CI", cd: "CD" } as Record<string, string>)[domain],
			state: selected?.activities
				.filter((item) => item.domain === domain)
				.at(-1)
				?.label.includes("需关注")
				? "需关注"
				: selected?.activities.some((item) => item.domain === domain)
					? "已记录"
					: "尚无记录",
		})),
		canPause,
		runtime: !board.online
			? "本机离线"
			: board.cron?.state === "error"
				? "运行异常"
				: board.cron?.paused
					? "调度已暂停"
					: board.cron?.state === "running"
						? "本机在线 · 执行中"
						: "本机在线 · 等待下一周期",
		desiredPaused: board.desiredPaused,
		pausePending: board.pausePending,
		nextRunAt: board.cron?.nextRunAt ?? null,
		errors: [...board.errors, ...(board.cron?.lastError ? ["本机上报异常，请检查运行状态"] : [])],
	};
}
async function record(account: string, id: string): Promise<Resource | null> {
	try {
		const response = await apiGet<{ account_id: string; item: Resource }>(
			`agent/accounts/${account}/records/${id}`,
		);
		if (response.account_id !== account || response.item.account_id !== account)
			throw new Error("Account changed");
		return response.item;
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) return null;
		throw error;
	}
}
export async function loadWork(): Promise<WorkData> {
	const account = await ensureSession();
	const [cron, control] = await Promise.all([
		record(account, "work-cron"),
		record(account, "work-control"),
	]);
	const jobs: Resource[] = [];
	let cursor: string | null = null;
	const seen = new Set<string>();
	for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
		const params = new URLSearchParams({
			type: "work-run",
			limit: "100",
			...(cursor ? { cursor } : {}),
		});
		const page = await apiGet<{ account_id: string; items: Resource[]; nextCursor: string | null }>(
			`agent/accounts/${account}/jobs?${params}`,
		);
		if (
			page.account_id !== account ||
			page.items.some((row) => row.account_id !== account) ||
			getActiveAccountId() !== account
		)
			throw new Error("Account changed");
		jobs.push(...page.items);
		if (!page.nextCursor) return { account_id: account, jobs, cron, control };
		if (seen.has(page.nextCursor)) throw new Error("Invalid pagination");
		seen.add(page.nextCursor);
		cursor = page.nextCursor;
	}
	throw new Error("Work history exceeds display bound");
}
export async function setWorkPaused(account: string, current: Resource | null, paused: boolean) {
	if (getActiveAccountId() !== account || (current && current.account_id !== account))
		throw new Error("Account changed");
	const path = `agent/accounts/${account}/records`;
	const patch = { status: paused ? "paused" : "enabled", payload: { paused } };
	const result = current
		? await apiWrite<{ account_id: string; item: Resource }>(`${path}/work-control`, "PATCH", {
				revision: current.revision,
				...patch,
			})
		: await apiPost<{ account_id: string; item: Resource }>(path, {
				id: "work-control",
				type: "work-control",
				...patch,
				repository: null,
				source_version: null,
			});
	if (
		result.account_id !== account ||
		result.item.account_id !== account ||
		getActiveAccountId() !== account
	)
		throw new Error("Account changed");
	return result.item;
}
