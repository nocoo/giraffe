import { Badge, Button } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import {
	Activity,
	ArrowRight,
	Bot,
	Brain,
	CheckCheck,
	Clock3,
	Database,
	GitBranch,
	GitPullRequest,
	History,
	ListChecks,
	Pause,
	Play,
	Radar,
	ShieldCheck,
	Workflow,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DataTimeSource } from "../components/layout/data-time";
import { useAnalysisRead } from "../components/layout/use-analysis-read";
import { formatPreciseDate } from "../lib/format";
import { getActiveAccountId } from "../viewmodels/session";
import { loadWork, setWorkPaused, type WorkData, workExperience } from "../viewmodels/work";
import "./work.css";

const nodeIcons = {
	observations: Database,
	coordinator: Workflow,
	jev: Brain,
	preparation: GitBranch,
	worker: Bot,
	reviewer: ShieldCheck,
	publish: GitPullRequest,
	followup: Radar,
	analysts: ListChecks,
};

export function WorkPage() {
	const [data, setData] = useState<WorkData | null>(null);
	const [error, setError] = useState("");
	const [controlError, setControlError] = useState("");
	const [busy, setBusy] = useState(false);
	const [now, setNow] = useState(Date.now);
	const [selection, setSelection] = useState<{ account: string; id: string } | null>(null);
	const [nodeId, setNodeId] = useState("coordinator");
	useAnalysisRead(
		loadWork,
		(value) => {
			setData(value);
			setError("");
		},
		() => setError("Agent 状态暂时不可用，保留上次记录。"),
		5000,
	);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 5000);
		return () => clearInterval(timer);
	}, []);
	const board = useMemo(
		() =>
			data
				? workExperience(data, now, selection?.account === data.account_id ? selection.id : null)
				: null,
		[data, now, selection],
	);
	const selected = board?.selected;
	const node = board?.nodes.find((item) => item.id === nodeId);
	async function pause() {
		if (!data || !board?.canPause || busy) return;
		setBusy(true);
		setControlError("");
		try {
			const control = await setWorkPaused(data.account_id, data.control, !board.desiredPaused);
			if (getActiveAccountId() === data.account_id)
				setData((latest) =>
					latest?.account_id === data.account_id ? { ...latest, control } : latest,
				);
		} catch {
			setControlError("控制保存失败，请重新读取后重试。");
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="agent-desk" data-testid="work-desk">
			<DataTimeSource entries={[{ label: "Agent 运行记录", at: selected?.updatedAt ?? null }]} />
			<PageHeader
				title="Agent"
				description="从观察到交付 · 一个主控，独立审查，四域分析"
				actions={
					<Button
						size="sm"
						variant="secondary"
						disabled={!board?.canPause || busy || board.pausePending}
						icon={board?.desiredPaused ? <Play size={16} /> : <Pause size={16} />}
						onClick={() => void pause()}
					>
						{busy ? "正在保存…" : board?.desiredPaused ? "恢复调度" : "暂停调度"}
					</Button>
				}
			/>
			<div className="agent-status-strip">
				<Badge variant={board?.runtime.includes("在线") ? "teal" : "secondary"} dot>
					{board?.runtime ?? "正在读取状态"}
				</Badge>
				{board?.pausePending ? (
					<Badge variant="warning">{board.desiredPaused ? "等待暂停确认" : "等待恢复确认"}</Badge>
				) : null}
				<span>
					<Clock3 size={15} /> 下一周期 <time>{formatPreciseDate(board?.nextRunAt ?? null)}</time>
				</span>
				<span className="agent-muted">只读观察 · 仅可暂停或恢复调度</span>
			</div>
			{error || controlError || board?.errors.length ? (
				<p role="alert" className="text-basalt-destructive">
					{[error, controlError, ...(board?.errors ?? [])].filter(Boolean).join("；")}
				</p>
			) : null}
			<LayerCard className="agent-architecture">
				<LayerCard.Header>
					<div className="agent-section-title">
						<Workflow size={18} />
						<h2>协作架构</h2>
						<span className="agent-muted">
							{selected?.current ? "当前周期" : "职责与已保存证据"}
						</span>
					</div>
				</LayerCard.Header>
				<LayerCard.Body>
					{!board ? (
						<p className="agent-muted">
							{error ? "暂时无法读取架构状态，请等待重新连接。" : "正在读取架构状态…"}
						</p>
					) : (
						<>
							<section className="agent-topology" aria-label="Agent 协作架构">
								{board.nodes.map((item, index) => {
									const Icon = nodeIcons[item.id as keyof typeof nodeIcons];
									return (
										<div
											className={`agent-node-wrap agent-node-${item.id}`}
											key={item.id}
											data-tone={item.tone}
										>
											<Button
												variant="ghost"
												className="agent-node"
												aria-pressed={nodeId === item.id}
												aria-controls="agent-node-detail"
												onClick={() => setNodeId(item.id)}
											>
												<span className="agent-node-icon">
													<Icon size={21} />
												</span>
												<span className="agent-node-copy">
													<strong>{item.title}</strong>
													<span>{item.subtitle}</span>
													<small data-active={item.state === "进行中"}>{item.state}</small>
												</span>
											</Button>
											{index < 7 ? (
												<ArrowRight className="agent-connector" size={16} aria-hidden="true" />
											) : null}
										</div>
									);
								})}
								<div className="agent-analyst-domains">
									<span className="agent-branch-label">
										<Workflow size={16} />
										主控分支 → 并行分析
									</span>
									{board.analysts.map((domain) => (
										<Badge
											key={domain.id}
											variant={domain.state === "需关注" ? "warning" : "purple"}
										>
											{domain.label} · {domain.state}
										</Badge>
									))}
									<span className="agent-muted">与仓库执行并行 · 报告独立保留</span>
								</div>
							</section>
							<LayerCard.Well
								className="agent-node-detail"
								id="agent-node-detail"
								role="region"
								aria-label="节点详情"
								aria-live="polite"
							>
								<strong>{node?.title}</strong>
								<span>{node?.responsibility}</span>
								<span className="agent-muted">
									{node?.state}
									{node?.models.length
										? ` · ${node.models.join(" · ")}`
										: ["coordinator", "worker", "reviewer", "analysts"].includes(nodeId)
											? " · 模型未上报"
											: ""}
								</span>
							</LayerCard.Well>
						</>
					)}
				</LayerCard.Body>
			</LayerCard>
			<div className="agent-records">
				<LayerCard className="agent-history">
					<LayerCard.Header>
						<div className="agent-section-title">
							<History size={18} />
							<h2>周期记录</h2>
							<span className="agent-muted">{board?.runs.length ?? 0} 次</span>
						</div>
					</LayerCard.Header>
					<LayerCard.Body>
						<section className="agent-history-list" aria-label="周期记录选择">
							{board?.runs.map((run) => (
								<Button
									variant="ghost"
									key={run.id}
									className="agent-history-item"
									aria-pressed={selected?.id === run.id}
									onClick={() => data && setSelection({ account: data.account_id, id: run.id })}
								>
									<time>{formatPreciseDate(run.createdAt)}</time>
									<span>
										{run.current ? "实时周期" : "历史记录"} · {run.status}
									</span>
									<small>
										{run.repositories.length} 个仓库 · {run.activities.length} 条活动
									</small>
								</Button>
							))}
						</section>
						{!board?.runs.length ? (
							<p className="agent-muted">
								{data ? "尚无周期记录；架构职责已就绪，等待本机上报。" : "正在读取周期记录…"}
							</p>
						) : null}
					</LayerCard.Body>
				</LayerCard>
				<div className="agent-run-column">
					<LayerCard>
						<LayerCard.Header>
							<div className="agent-section-title">
								<Activity size={18} />
								<h2>{selected?.current ? "当前运行" : "周期概览"}</h2>
								<Badge variant="secondary">{selected?.current ? "实时周期" : "历史记录"}</Badge>
								{selection ? (
									<Button size="sm" variant="ghost" onClick={() => setSelection(null)}>
										返回实时
									</Button>
								) : null}
							</div>
						</LayerCard.Header>
						<LayerCard.Body>
							{selected ? (
								<>
									<div className="agent-run-summary">
										<strong>{selected.status}</strong>
										<span>{selected.repositories.length} 个仓库</span>
										<span>
											{selected.repositories.reduce((sum, repo) => sum + repo.tasks.length, 0)}{" "}
											项任务
										</span>
										<span className="agent-muted">
											更新 <time>{formatPreciseDate(selected.updatedAt)}</time>
										</span>
									</div>
									{selected.analysisAttention ? (
										<p className="text-basalt-destructive">分析或报告交付需关注，未视为成功。</p>
									) : null}
									{selected.empty ? (
										<div className="agent-idle">
											<CheckCheck size={24} />
											<div>
												<strong>
													{selected.status === "已完成"
														? "周期已结束，未选择执行仓库"
														: "等待仓库执行证据"}
												</strong>
												<p>{selected.empty}</p>
												<span className="agent-muted">
													没有 Worker 或发布证据时，不展示成功交付。
												</span>
											</div>
										</div>
									) : null}
									<div className="agent-repositories">
										{selected.repositories.map((repo) => (
											<LayerCard.Well className="agent-repository" key={repo.key}>
												<div className="agent-repo-heading">
													<strong>{repo.name}</strong>
													<Badge variant="secondary">{repo.status}</Badge>
													<span>轮次 {repo.round}/20</span>
												</div>
												<ol className="agent-phases" aria-label={`${repo.name} 执行阶段`}>
													{repo.phases.map((phase, phaseIndex) => (
														<li key={phase} data-current={phaseIndex === repo.phase}>
															<span>{phaseIndex + 1}</span>
															{phase}
														</li>
													))}
												</ol>
												<div className="agent-pair">
													<div>
														<Bot size={16} />
														<strong>Worker</strong>
														<span>
															{repo.worker} · {repo.workerModel}
														</span>
													</div>
													<div>
														<ShieldCheck size={16} />
														<strong>Reviewer</strong>
														<span>
															{repo.reviewer} · {repo.reviewerModel}
														</span>
													</div>
												</div>
												<div className="agent-task-list">
													{repo.tasks.map((task) => (
														<span key={task.key}>
															{task.label} · {task.outcome}
															{task.reason ? ` · ${task.reason}` : ""}
														</span>
													))}
												</div>
												{repo.detailsOmitted ? (
													<p className="agent-muted">详细原因已省略；保留已上报的任务结果。</p>
												) : null}
												<div className="agent-repo-footer">
													<span>{repo.findings}</span>
													{repo.findingCategories.map((category) => (
														<Badge key={category} variant="warning">
															{category}
														</Badge>
													))}
													<span>
														{repo.pushed ? "已有推送记录" : "尚未推送"} · {repo.followup}
													</span>
												</div>
											</LayerCard.Well>
										))}
									</div>
								</>
							) : (
								<p className="agent-muted">
									{data ? "尚无执行周期。本机在线状态与下一周期见页首。" : "正在读取运行概览…"}
								</p>
							)}
						</LayerCard.Body>
					</LayerCard>
					<LayerCard>
						<LayerCard.Header>
							<div className="agent-section-title">
								<Activity size={18} />
								<h2>活动轨迹</h2>
								<span className="agent-muted">按发生顺序 · 无单条时间戳</span>
							</div>
						</LayerCard.Header>
						<LayerCard.Body>
							<ol className="agent-activities">
								{selected?.activities.map((activity) => (
									<li key={activity.key}>
										<span className="agent-activity-order">{activity.order}</span>
										<Badge variant={activity.category === "关注" ? "warning" : "secondary"}>
											{activity.category}
										</Badge>
										<span>{activity.label}</span>
									</li>
								))}
							</ol>
							{selected?.omittedEvents ? (
								<p className="agent-muted">
									另有 {selected.omittedEvents} 条未分类活动；为避免显示工具输出，未展示原文。
								</p>
							) : null}
							{!selected?.activities.length ? (
								<p className="agent-muted">尚无可展示的结构化活动；心跳不代表执行成功。</p>
							) : null}
						</LayerCard.Body>
					</LayerCard>
				</div>
			</div>
		</div>
	);
}
