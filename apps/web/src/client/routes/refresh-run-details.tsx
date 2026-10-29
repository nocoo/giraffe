import { Button } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@nocoo/basalt/components/table";
import {
	AlertCircle,
	Check,
	ChevronRight,
	Circle,
	Clock3,
	Info,
	LoaderCircle,
	Minus,
	Pause,
	Square,
} from "lucide-react";
import type { RefreshDimension, RefreshRun } from "../../lib/refresh-types";
import { CandyBadge } from "../components/layout/candy-badge";
import { ProjectLabel } from "../components/layout/project-identity";
import { formatCount, formatPreciseDate, NUM_CELL, NUM_HEAD } from "../lib/format";
import { REFRESH_LABELS, refreshActive, refreshStatus } from "../viewmodels/refresh";
import {
	canCancelRefresh,
	type RefreshReason,
	type RefreshRepoRow,
	type RefreshStepStatus,
	refreshAccountRow,
	refreshCurrentStep,
	refreshFailureText,
	refreshProblemRepos,
	refreshProgressOf,
	refreshReasons,
	refreshRepoRows,
	refreshRequestNote,
	refreshRequestRows,
	refreshScopeLabel,
	type refreshStepTiming,
	refreshTimingRows,
	refreshTimings,
	refreshWindowLabel,
} from "../viewmodels/refresh-center";

const DIMENSION_SHORT: Record<RefreshDimension, string> = {
	commits: "提交",
	issues: "Issues",
	prs: "PRs",
	actions: "CI",
	releases: "发布",
	alerts: "告警",
};

const STEP_ICON = {
	complete: Check,
	partial: AlertCircle,
	running: LoaderCircle,
	pending: Circle,
	skipped: Minus,
	interrupted: Pause,
	failed: AlertCircle,
};

function stepIcon(status: RefreshStepStatus) {
	const Icon = STEP_ICON[status];
	return <Icon aria-hidden="true" className={status === "running" ? "animate-spin" : ""} />;
}

function statusTone(status: RefreshRun["status"]) {
	if (status === "completed") return "green" as const;
	if (status === "partial") return "amber" as const;
	if (status === "failed") return "red" as const;
	if (status === "cancelled") return "gray" as const;
	return "blue" as const;
}

function reasonGroups(run: RefreshRun) {
	const account = run.partialReasons
		.filter((reason) => reason.repo === null)
		.flatMap(refreshReasons);
	const repos = [
		...new Set(run.partialReasons.flatMap((reason) => (reason.repo ? [reason.repo] : []))),
	];
	const groups = [
		...(account.length ? [{ key: "account", label: "账号 / 页面", reasons: account }] : []),
		...repos.map((repo) => ({
			key: repo,
			label: repo,
			reasons: run.partialReasons.filter((reason) => reason.repo === repo).flatMap(refreshReasons),
		})),
	];
	if (!groups.length && run.errorCode)
		return [
			{
				key: "error",
				label: "运行错误",
				reasons: refreshReasons({ repo: null, codes: [run.errorCode] }),
			},
		];
	return groups;
}

function timingText(timing: ReturnType<typeof refreshStepTiming>): string | null {
	if (!timing) return null;
	const boundary = timing.finishedAt
		? `完成 ${formatPreciseDate(timing.finishedAt)}`
		: `开始 ${formatPreciseDate(timing.startedAt)} · 未完成`;
	return `${boundary} · 耗时 ${timing.durationLabel} · 尝试 ${timing.attempts} 次`;
}

function ReasonList({ reasons }: { reasons: RefreshReason[] }) {
	return (
		<ul>
			{reasons.map((reason) => (
				<li
					key={`${reason.dimension ?? "run"}:${reason.code}`}
					data-info={reason.dimension === null}
				>
					<strong>{reason.label}</strong>
					{reason.failures.map((failure) => (
						<span key={refreshFailureText(failure)}>{refreshFailureText(failure)}</span>
					))}
				</li>
			))}
		</ul>
	);
}

function RepoRow({ row }: { row: RefreshRepoRow }) {
	const problems = row.reasons.length;
	return (
		<details className="refresh-run-row" data-status={row.status} open={row.status === "running"}>
			<summary>
				<ChevronRight className="refresh-disclosure" aria-hidden="true" />
				<span className="refresh-queue-repo">
					<strong>
						<ProjectLabel repo={row.repo} />
					</strong>
					<small>
						{row.label}
						{row.timing ? ` · 耗时 ${row.timing.durationLabel}` : ""}
						{problems ? ` · ${problems} 项原因` : ""}
					</small>
				</span>
				<span className="refresh-mini-dims" role="img" aria-label={`${row.repo} 各维度状态`}>
					{row.dimensions.map((dimension) => (
						<span key={dimension.dimension} data-state={dimension.state} title={dimension.label}>
							{DIMENSION_SHORT[dimension.dimension]}
						</span>
					))}
				</span>
				<span className="refresh-queue-count">
					{row.dimensions.filter((dimension) => dimension.state === "complete").length} /{" "}
					{row.dimensions.length} 维度
				</span>
			</summary>
			<div className="refresh-repo-steps">
				<ul className="refresh-dimension-list">
					{row.dimensions.map((dimension) => (
						<li key={dimension.dimension} data-state={dimension.state}>
							<strong>{REFRESH_LABELS[dimension.dimension]}</strong>
							<span>{dimension.label.split(" · ")[1]}</span>
							{dimension.reasons.map((reason) => (
								<em key={`${reason.dimension ?? "run"}:${reason.code}`}>{reason.label}</em>
							))}
						</li>
					))}
				</ul>
				{row.reasons.some((reason) => reason.dimension === null) ? (
					<p className="refresh-step-time">
						{row.reasons
							.filter((reason) => reason.dimension === null)
							.map((reason) => reason.label)
							.join("；")}
					</p>
				) : null}
				{timingText(row.timing) ? (
					<p className="refresh-step-time">{timingText(row.timing)}</p>
				) : (
					<p className="refresh-step-time">这次运行没有保存该仓库的逐步时间。</p>
				)}
			</div>
		</details>
	);
}

export function RefreshRunDetails({
	run,
	now,
	onCancel,
	cancelling = false,
}: {
	run: RefreshRun;
	now: number;
	onCancel?: () => void;
	cancelling?: boolean;
}) {
	const progress = refreshProgressOf(run);
	const account = refreshAccountRow(run, now);
	const rows = refreshRepoRows(run, now);
	const requests = refreshRequestRows(run);
	const requestNote = refreshRequestNote(run);
	const groups = reasonGroups(run);
	const problems = refreshProblemRepos(run);
	const timings = refreshTimings(run);
	const active = refreshActive(run);
	const cancelable = canCancelRefresh(run) && onCancel !== undefined;
	const bProcessed = rows.filter(
		(row) => row.status === "complete" || row.status === "partial",
	).length;
	const bPartial = rows.filter((row) => row.status === "partial").length;
	const bInterrupted = rows.some((row) => row.status === "interrupted");
	const bStatus: RefreshStepStatus = !rows.length
		? "pending"
		: bProcessed === rows.length
			? bPartial
				? "partial"
				: "complete"
			: active
				? "running"
				: bInterrupted
					? "interrupted"
					: bProcessed
						? "partial"
						: "skipped";
	return (
		<div className="refresh-run-details">
			<section className="refresh-run-overview" aria-label="本次刷新进度">
				<div className="refresh-run-overview-heading">
					<div>
						<p className="refresh-eyebrow">
							{refreshScopeLabel(run)} · {run.trigger === "scheduled" ? "每日自动" : "手动发起"}
						</p>
						<h3>
							{refreshStatus(run)} · {refreshWindowLabel(run)}
						</h3>
					</div>
					<div className="refresh-run-fraction">
						<strong>
							{progress.processed}
							<span> / {progress.total}</span>
						</strong>
						<small>步已处理</small>
					</div>
				</div>
				<div className="refresh-progress-track">
					<progress
						className="sr-only"
						max={progress.total}
						value={progress.processed}
						aria-label="本次刷新进度"
					/>
					<div className="refresh-progress-segments" aria-hidden="true">
						<span
							data-status="complete"
							style={{ width: `${(progress.complete / progress.total) * 100}%` }}
						/>
						<span
							data-status="partial"
							style={{ width: `${(progress.partial / progress.total) * 100}%` }}
						/>
						<span
							data-status="pending"
							style={{ width: `${(progress.pending / progress.total) * 100}%` }}
						/>
						<span
							data-status="skipped"
							style={{ width: `${(progress.skipped / progress.total) * 100}%` }}
						/>
					</div>
				</div>
				<div className="refresh-progress-legend">
					<span data-status="complete">
						<Check aria-hidden="true" />
						已完成 {progress.complete}
					</span>
					<span data-status="partial">
						<AlertCircle aria-hidden="true" />
						部分 {progress.partial}
					</span>
					<span data-status="pending">
						<Clock3 aria-hidden="true" />
						待处理 {progress.pending}
					</span>
					<span data-status="skipped">
						<Minus aria-hidden="true" />
						未完成 {progress.skipped}
					</span>
					<span className="ml-auto">
						<Clock3 aria-hidden="true" />
						耗时 {refreshTimingRows(run, now).at(-1)?.value ?? "—"}
					</span>
				</div>
				<p className="refresh-current-step" role="status">
					{refreshCurrentStep(run)}
					{run.cancelRequested ? " · 已请求取消，当前步骤结束后停止。" : ""}
				</p>
				<ol className="refresh-run-phases" aria-label="刷新阶段">
					<li
						data-complete={account.status === "complete"}
						data-warning={account.status === "partial" || account.status === "failed"}
						data-skipped={account.status === "skipped"}
					>
						<span className="refresh-phase-number">{stepIcon(account.status)}</span>
						<div>
							<strong>A · 账号信息、贡献与仓库清单</strong>
							<small>
								{account.label}
								{account.requests.graphql !== null || account.requests.rest !== null
									? ` · GraphQL ${account.requests.graphql ?? "—"} / REST ${account.requests.rest ?? "—"}`
									: ""}
								{account.note ? ` · ${account.note}` : ""}
								{timingText(account.timing) ? ` · ${timingText(account.timing)}` : ""}
							</small>
						</div>
					</li>
					<li
						data-complete={rows.length > 0 && bProcessed === rows.length}
						data-warning={bPartial > 0}
						data-skipped={rows.length > 0 && bProcessed === 0}
					>
						<span className="refresh-phase-number">{rows.length ? stepIcon(bStatus) : "2"}</span>
						<div>
							<strong>B · 仓库串行刷新</strong>
							<small>
								{bProcessed} / {rows.length} 个仓库已处理
								{bPartial ? ` · ${bPartial} 个部分完成` : ""}
								{active && run.phase === "repos" ? ` · 当前 ${refreshCurrentStep(run)}` : ""}
							</small>
						</div>
					</li>
				</ol>
				<dl className="refresh-run-times">
					{refreshTimingRows(run, now).map((row) => (
						<div key={row.label}>
							<dt>{row.label}</dt>
							<dd>{row.value}</dd>
						</div>
					))}
					<div>
						<dt>状态</dt>
						<dd>
							<CandyBadge tone={statusTone(run.status)}>{refreshStatus(run)}</CandyBadge>
						</dd>
					</div>
				</dl>
				{cancelable || run.cancelRequested ? (
					<div className="refresh-active-controls">
						<div>
							<strong>{run.cancelRequested ? "已请求取消" : "结束本次刷新"}</strong>
							<p>已写入的观测和数据保留，不会回滚。</p>
						</div>
						{cancelable ? (
							<Button size="sm" variant="secondary" disabled={cancelling} onClick={onCancel}>
								<Square className="size-3.5" aria-hidden="true" />
								{cancelling ? "正在取消…" : "结束本次刷新"}
							</Button>
						) : null}
					</div>
				) : null}
			</section>
			<LayerCard aria-label="请求统计">
				<LayerCard.Header>
					<h3 className="text-sm font-medium">GitHub 请求 · A / B 拆分</h3>
				</LayerCard.Header>
				<LayerCard.Body>
					<Table className="refresh-request-table">
						<TableHeader>
							<TableRow>
								<TableHead>阶段</TableHead>
								<TableHead className={NUM_HEAD}>GraphQL</TableHead>
								<TableHead className={NUM_HEAD}>REST</TableHead>
								<TableHead className={NUM_HEAD}>合计</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{requests.map((row) => (
								<TableRow key={row.key}>
									<TableCell>{row.label}</TableCell>
									<TableCell className={NUM_CELL}>
										{row.graphql === null ? "—" : formatCount(row.graphql)}
									</TableCell>
									<TableCell className={NUM_CELL}>
										{row.rest === null ? "—" : formatCount(row.rest)}
									</TableCell>
									<TableCell className={NUM_CELL}>
										{row.total === null ? "—" : formatCount(row.total)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
					<p className="refresh-request-note">
						{requestNote ??
							`实际发出的 GitHub 请求；A 与 B 的拆分合计等于本次 ${formatCount(run.requests)} 次。`}
					</p>
				</LayerCard.Body>
			</LayerCard>
			<LayerCard className="refresh-run-issues" aria-label="部分数据原因">
				<LayerCard.Header>
					<h3 className="text-sm font-medium">部分数据与原因</h3>
				</LayerCard.Header>
				<LayerCard.Body>
					{groups.length ? (
						<>
							<div className="refresh-section-heading">
								<p>缺失的数据保持缺失，不记为 0；相同原因已合并。</p>
								<span>
									{problems.length ? `${problems.length} 个范围需要关注` : "仅运行级原因"}
								</span>
							</div>
							{groups.map((group, index) => (
								<details key={group.key} className="refresh-issue" open={index === 0}>
									<summary>
										<AlertCircle aria-hidden="true" />
										<strong>{group.label}</strong>
										<span>{group.reasons.length} 项原因</span>
										<ChevronRight className="refresh-disclosure" aria-hidden="true" />
									</summary>
									<div className="refresh-issue-body">
										<ReasonList reasons={group.reasons} />
									</div>
								</details>
							))}
						</>
					) : (
						<p className="refresh-console-note">
							<Info aria-hidden="true" />
							这次运行没有记录部分数据原因。缺失日期仍表示未观测，不代表零。
						</p>
					)}
				</LayerCard.Body>
			</LayerCard>
			<section className="refresh-run-repositories" aria-label="逐仓库刷新进度">
				<div className="refresh-section-heading">
					<h3>仓库进度 · A 之后的串行 B</h3>
					<span>展开仓库，查看维度状态与原因</span>
				</div>
				{rows.length ? (
					<div className="refresh-run-queue">
						{rows.map((row) => (
							<RepoRow key={row.repo} row={row} />
						))}
					</div>
				) : (
					<div className="refresh-console-empty">
						<Circle aria-hidden="true" />
						<h3>还没有仓库进入 B</h3>
						<p>A 完成后，默认范围中的星标仓库与当日新仓库会逐个串行刷新。</p>
					</div>
				)}
			</section>
			<details className="refresh-diagnostics">
				<summary>运行信息</summary>
				<p>
					运行编号 <code>{run.id}</code> · {run.trigger === "scheduled" ? "每日自动" : "手动"} ·
					账号 <code>{run.accountId}</code>
				</p>
				<p>
					观测窗口 {run.params.since} → {run.params.until}（{run.params.timezone}），维度{" "}
					{run.params.dimensions.map((dimension) => REFRESH_LABELS[dimension]).join("、")}
					{run.params.force ? " · 强制重采" : ""}
					{run.params.repo ? ` · 指定仓库 ${run.params.repo}` : ""}
				</p>
				<p>
					已处理 {run.completedRepos} / {run.repos.length} 个仓库 · 共 {formatCount(run.requests)}{" "}
					次请求
					{run.aReused ? " · A 复用当日账号数据" : ""}
					{run.errorCode ? ` · 错误代码 ${run.errorCode}` : ""}
				</p>
				<p>
					{timings
						? "逐步时间来自本次运行记录；未完成的步骤只显示已开始时间。"
						: "这次运行没有保存逐步时间戳，只显示运行级开始、更新与结束时间。"}
				</p>
			</details>
		</div>
	);
}
