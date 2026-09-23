import { Button, SegmentControl } from "@nocoo/basalt";
import {
	AlertCircle,
	ArrowUpRight,
	Check,
	ChevronRight,
	Circle,
	Clock3,
	Info,
	LoaderCircle,
	Minus,
	Pause,
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
	FactoryRunStep,
	FactoryRunView,
	RepoRefreshState,
	RunStatus,
	StepStatus,
} from "../../lib/factory-run";
import { SearchField } from "../components/layout/collection-chrome";
import { INLINE_SEGMENT } from "../components/layout/segment";
import { formatUtc } from "../viewmodels/factory";
import {
	describeRunIssue,
	formatRunDuration,
	RUN_LABELS,
	runIssues,
	runRepositoryRows,
	runStages,
	STEP_STATUS,
	secondsUntil,
	stepLabel,
} from "../viewmodels/factory-runs";

const STATUS_ICON = {
	pending: Circle,
	running: LoaderCircle,
	success: Check,
	failed: AlertCircle,
	skipped: Minus,
};

function StepIcon({ status, paused = false }: { status: StepStatus; paused?: boolean }) {
	const Icon = paused ? Pause : STATUS_ICON[status];
	return (
		<span className="factory-step-icon" data-status={paused ? "pending" : status}>
			<Icon aria-hidden="true" className={status === "running" && !paused ? "animate-spin" : ""} />
		</span>
	);
}

export function FactoryProgressBar({ run, label }: { run: FactoryRunView; label: string }) {
	return (
		<div className="factory-progress-track">
			<progress
				className="sr-only"
				max={run.progress.total || 1}
				value={run.progress.completed}
				aria-label={label}
			/>
			<div className="factory-progress-segments" aria-hidden="true">
				{(["success", "failed", "skipped"] as const).map((status) => (
					<span
						key={status}
						data-status={status}
						style={{ width: `${(run.progress[status] / Math.max(1, run.progress.total)) * 100}%` }}
					/>
				))}
			</div>
		</div>
	);
}

function StepTimeline({ steps, status }: { steps: FactoryRunStep[]; status: RunStatus }) {
	return (
		<ol className="factory-step-timeline">
			{steps.map((step) => {
				const issue =
					step.error || step.status === "failed"
						? describeRunIssue(step.error, step.kind, step.resource)
						: null;
				const paused = status === "paused" && step.startedAt !== null && step.finishedAt === null;
				const stopped =
					(status === "cancelled" || status === "failed") &&
					(step.status === "pending" || step.status === "running");
				return (
					<li key={step.resource ?? step.kind} data-status={step.status}>
						<StepIcon status={stopped ? "skipped" : step.status} paused={paused} />
						<div className="min-w-0 flex-1">
							<div className="factory-step-title">
								<strong>{stepLabel(step)}</strong>
								<span>{stopped ? "未执行完" : paused ? "已暂停" : STEP_STATUS[step.status]}</span>
								{step.startedAt ? (
									<small>
										{step.pages > 0 ? `${step.pages} 页 · ` : ""}
										{formatRunDuration(Math.ceil(step.durationMs / 1000))}
									</small>
								) : null}
							</div>
							{issue ? (
								<p className="factory-step-explanation">
									{issue.title}。{issue.action}
								</p>
							) : null}
						</div>
					</li>
				);
			})}
		</ol>
	);
}

export function FactoryRunDetails({
	run,
	states,
	now,
	onRetry,
}: {
	run: FactoryRunView;
	states: RepoRefreshState[];
	now: number;
	onRetry: (repos: string[]) => void;
}) {
	const [onlyProblems, setOnlyProblems] = useState(false);
	const [query, setQuery] = useState("");
	const rows = useMemo(() => runRepositoryRows(run, states), [run, states]);
	const issues = useMemo(() => runIssues(run), [run]);
	const stages = useMemo(() => runStages(run), [run]);
	const problemRepos = new Set(issues.flatMap((issue) => issue.repos));
	const visible = rows.filter(
		(row) =>
			(!onlyProblems || problemRepos.has(row.repo)) &&
			row.repo.toLowerCase().includes(query.toLowerCase()),
	);
	const waiting = run.status === "running" ? secondsUntil(run.nextAttemptAt, now) : 0;
	const active = run.status === "running" || run.status === "paused";
	const current = active ? run.progress.current : null;
	const globalSteps = run.steps.filter((step) => !step.repo);
	const full = run.steps.some((step) => step.resource === "repos");
	return (
		<div className="factory-run-details">
			<section className="factory-run-overview" aria-label="本次刷新进度">
				<div className="factory-run-overview-heading">
					<div>
						<p className="factory-eyebrow">
							{run.mode === "catalog"
								? "同步仓库列表"
								: `${full ? "全站刷新" : "仓库刷新"} · ${run.repos.length} 个统计仓库`}
						</p>
						<h3>{RUN_LABELS[run.status]}</h3>
					</div>
					<div className="factory-run-fraction">
						<strong>
							{run.progress.completed}
							<span> / {run.progress.total}</span>
						</strong>
						<small>步已处理</small>
					</div>
				</div>
				<FactoryProgressBar run={run} label="本次刷新进度" />
				<div className="factory-progress-legend">
					<span data-status="success">
						<Check aria-hidden="true" />
						已完成 {run.progress.success}
					</span>
					<span data-status="failed">
						<AlertCircle aria-hidden="true" />
						未完成 {run.progress.failed}
					</span>
					<span data-status="skipped">
						<Minus aria-hidden="true" />
						已跳过 {run.progress.skipped}
					</span>
					{active ? (
						<span className="ml-auto">
							<Clock3 aria-hidden="true" />
							{run.status === "paused"
								? "等待继续"
								: run.progress.etaSeconds === null
									? "正在估算剩余时间"
									: `预计还需 ${formatRunDuration(run.progress.etaSeconds)}`}
						</span>
					) : null}
				</div>
				{current ? (
					<p className="factory-current-step" role="status">
						{run.status === "paused" ? "暂停在" : waiting ? "等待继续" : "正在处理"}：
						<strong>
							{current.repo ? `${current.repo} · ` : ""}
							{stepLabel(current)}
						</strong>
					</p>
				) : (
					<p className="factory-current-step">进度表示任务已处理；数据是否完整，请查看下方结果。</p>
				)}
				<ol className="factory-run-phases" aria-label="刷新阶段">
					{stages.map((stage, index) => (
						<li
							key={stage.title}
							data-complete={stage.total > 0 && stage.completed === stage.total}
							data-warning={stage.failed > 0}
						>
							<span className="factory-phase-number">
								{stage.total > 0 && stage.completed === stage.total ? (
									stage.failed ? (
										<AlertCircle aria-hidden="true" />
									) : (
										<Check aria-hidden="true" />
									)
								) : (
									index + 1
								)}
							</span>
							<div>
								<strong>{stage.title}</strong>
								<small>
									{stage.completed} / {stage.total} 步
									{stage.failed ? ` · ${stage.failed} 步未完成` : ""}
								</small>
							</div>
						</li>
					))}
				</ol>
			</section>
			{waiting > 0 ? (
				<p className="factory-console-note" role="status">
					<Clock3 aria-hidden="true" />
					预计 {formatRunDuration(waiting)} 后自动继续，不需要重复发起刷新。
				</p>
			) : null}
			{run.status === "running" && run.leaseUntil && secondsUntil(run.leaseUntil, now) === 0 ? (
				<p className="factory-console-note" role="status">
					<Info aria-hidden="true" />
					刷新暂时没有响应，系统会自动恢复。已有数据和进度保留。
				</p>
			) : null}
			{issues.length ? (
				<section className="factory-run-issues" aria-label="刷新问题与处理建议">
					<div className="factory-section-heading">
						<h3>需要关注</h3>
						<span>{issues.length} 类情况 · 相同问题已合并</span>
					</div>
					{issues.map((issue, index) => (
						<details
							key={issue.key}
							className="factory-issue"
							open={index === 0}
							data-info={
								issue.code === "repository_cooldown" || issue.code === "github_rate_limited"
							}
						>
							<summary>
								<AlertCircle aria-hidden="true" />
								<strong>{issue.title}</strong>
								<span>{issue.repos.length ? `${issue.repos.length} 个仓库` : "账号 / 页面"}</span>
								<ChevronRight className="factory-disclosure" aria-hidden="true" />
							</summary>
							<div className="factory-issue-body">
								<p>{issue.reason}</p>
								<div className="factory-issue-guidance">
									<div>
										<h4>对数据的影响</h4>
										<p>{issue.impact}</p>
									</div>
									<div>
										<h4>你可以这样做</h4>
										<p>{issue.action}</p>
									</div>
								</div>
								<div className="factory-issue-actions">
									{issue.settings ? (
										<a href="/settings">
											账号设置 <ArrowUpRight aria-hidden="true" />
										</a>
									) : null}
									{!active && (issue.repos.length || issue.kind === "snapshot") ? (
										<Button
											size="sm"
											variant="secondary"
											onClick={() => onRetry(issue.kind === "snapshot" ? [] : issue.repos)}
										>
											{issue.kind === "snapshot"
												? "重新发起全站刷新"
												: `选择这 ${issue.repos.length} 个仓库重试`}
										</Button>
									) : null}
								</div>
							</div>
						</details>
					))}
				</section>
			) : null}
			{rows.length ? (
				<section className="factory-run-repositories" aria-label="逐仓库刷新步骤">
					<div className="factory-section-heading">
						<h3>仓库进度</h3>
						<span>展开仓库，查看每一步的结果</span>
					</div>
					<div className="factory-queue-toolbar">
						<SegmentControl
							legend="筛选刷新结果"
							className={INLINE_SEGMENT}
							value={onlyProblems ? "problems" : "all"}
							onValueChange={(value) => setOnlyProblems(value === "problems")}
							options={[
								{ value: "all", label: `全部 ${rows.length}` },
								{ value: "problems", label: `需关注 ${problemRepos.size}` },
							]}
						/>
						<SearchField
							label="搜索刷新记录中的仓库"
							placeholder="搜索仓库…"
							value={query}
							onValueChange={setQuery}
						/>
					</div>
					<div className="factory-run-queue">
						{visible.map((row) => (
							<details key={row.repo} className="factory-run-row" data-status={row.status}>
								<summary>
									<ChevronRight className="factory-disclosure" aria-hidden="true" />
									<span className="factory-queue-repo">
										<strong>{row.repo}</strong>
										<small>{row.label}</small>
									</span>
									<span
										className="factory-mini-steps"
										role="img"
										aria-label={`${row.completed} / ${row.total} 步已处理，展开查看详情`}
									>
										{row.steps.map((step) => (
											<span
												key={step.resource ?? step.kind}
												data-status={step.status}
												title={`${stepLabel(step)}：${STEP_STATUS[step.status]}`}
											>
												{step.status === "success"
													? "✓"
													: step.status === "failed"
														? "!"
														: step.status === "skipped"
															? "−"
															: ""}
											</span>
										))}
									</span>
									<span className="factory-queue-count">
										{row.completed} / {row.total} 步
									</span>
								</summary>
								<div className="factory-repo-steps">
									<StepTimeline steps={row.steps} status={run.status} />
									<details className="factory-diagnostics">
										<summary>数据时间与诊断信息</summary>
										{row.state?.error ? (
											<p>
												最近一次保存结果：{describeRunIssue(row.state.error, "commit").title}。
												{describeRunIssue(row.state.error, "commit").impact}
											</p>
										) : null}
										{row.state ? (
											<p>
												工厂统计更新于 {formatUtc(row.state.refreshedAt)} ·{" "}
												{row.state.coverage ?? "—"} / 7 类完整。这里的时间独立于所选运行记录。
											</p>
										) : null}
										{row.state?.observation ? (
											<p>
												统计范围：{formatUtc(row.state.observation.window.since)} →{" "}
												{formatUtc(row.state.observation.window.until)} ·{" "}
												{row.state.observation.source === "legacy"
													? "从历史记录恢复"
													: "从 GitHub 获取"}
												。仓库信息更新于 {formatUtc(row.state.observation.metadataAt ?? null)}。
											</p>
										) : null}
										<p>
											{row.state
												? `工厂统计下次可刷新：${formatUtc(row.state.nextAllowedAt)} · `
												: ""}
											本次共 {row.pages} 页，耗时{" "}
											{formatRunDuration(Math.ceil(row.durationMs / 1000))}。
										</p>
										{row.steps
											.filter((step) => step.error)
											.map((step) => (
												<p key={step.resource ?? step.kind}>
													{stepLabel(step)}：<code>{step.error}</code> · 尝试 {step.attempts} 次
												</p>
											))}
									</details>
								</div>
							</details>
						))}
						{!visible.length ? (
							<p className="factory-console-empty">没有符合筛选条件的仓库。</p>
						) : null}
					</div>
				</section>
			) : null}
			{globalSteps.length ? (
				<details className="factory-global-steps" open={run.mode === "catalog"}>
					<summary>
						账号与页面更新步骤 <span>{globalSteps.length} 步</span>
					</summary>
					<StepTimeline steps={globalSteps} status={run.status} />
				</details>
			) : null}
			<details className="factory-diagnostics">
				<summary>运行信息</summary>
				<p>
					开始 {formatUtc(run.startedAt)} · 最后响应 {formatUtc(run.updatedAt)}
					{run.finishedAt ? ` · 结束 ${formatUtc(run.finishedAt)}` : ""}
				</p>
				<p>
					运行编号 <code>{run.id}</code> · 已发送 {run.requests} 次 GitHub 请求。
				</p>
				<p>
					仓库刷新仅更新对应统计和详情；全站刷新包含全站列表。同步仓库列表共 4 步。所有时间为 UTC。
				</p>
			</details>
		</div>
	);
}
