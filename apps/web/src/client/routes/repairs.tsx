import { Button, Link } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { Meter } from "@nocoo/basalt/components/meter";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import type { RepairProgress, RepairStage } from "@nocoo/giraffe-agent/repair-contracts";
import {
	ArrowUpRight,
	Clock3,
	GitBranch,
	Pause,
	Play,
	Radio,
	ShieldCheck,
	Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CandyBadge } from "../components/layout/candy-badge";
import { SearchField } from "../components/layout/collection-chrome";
import { DataTimeSource } from "../components/layout/data-time";
import { SelectField } from "../components/layout/select-field";
import { useAnalysisRead } from "../components/layout/use-analysis-read";
import { type CandyTone, formatPreciseDate, formatTimeAgo } from "../lib/format";
import {
	loadRepairs,
	REPAIR_PHASES,
	type RepairsData,
	repairBoard,
	repairLinks,
	STAGE_LABEL,
	setRepairPaused,
	signoffMatches,
} from "../viewmodels/repairs";

const tone = (stage: RepairStage): CandyTone =>
	stage === "pushed"
		? "green"
		: stage === "blocked" || stage === "exhausted"
			? "amber"
			: stage === "cancelled"
				? "gray"
				: "sky";
export function RepairsPage() {
	const [data, setData] = useState<RepairsData | null>(null);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [now, setNow] = useState(Date.now);
	const [selected, setSelected] = useState("");
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState("all");
	useAnalysisRead(
		loadRepairs,
		(value) => {
			setData(value);
			setError("");
		},
		() => setError("暂时无法读取修复状态，保留上次记录；正在退避重试。"),
		5000,
	);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 5000);
		return () => clearInterval(timer);
	}, []);
	const board = useMemo(() => (data ? repairBoard(data, now) : null), [data, now]);
	const rows = (board?.jobs ?? []).filter(
		(job) =>
			(filter === "all" || job.stage === filter) &&
			`${job.repository} ${job.title} ${job.issueNumber}`
				.toLowerCase()
				.includes(query.trim().toLowerCase()),
	);
	const job = rows.find((row) => row.id === selected) ?? rows[0];
	const cron = board?.cron;
	async function pause() {
		if (!data || !board) return;
		setBusy(true);
		setError("");
		try {
			const control = await setRepairPaused(data.account_id, data.control, !board.desiredPaused);
			setData({ ...data, control });
			setMessage("控制请求已保存，等待本地守护进程确认。");
		} catch {
			setError("控制记录保存失败或已变化，请重新读取后重试。");
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="space-y-4" data-testid="repairs-desk">
			{job ? <DataTimeSource entries={[{ label: "修复状态", at: job.updatedAt }]} /> : null}
			<PageHeader
				title="依赖修复"
				description="只处理依赖升级 Issue：独立工作区 → 检查 → Astra 审查 → 专用分支"
				actions={
					<Button
						size="sm"
						variant="secondary"
						disabled={!board || busy || board.errors.length > 0}
						onClick={() => void pause()}
					>
						{board?.desiredPaused ? (
							<Play className="size-4" aria-hidden="true" />
						) : (
							<Pause className="size-4" aria-hidden="true" />
						)}
						{busy ? "正在保存…" : board?.desiredPaused ? "恢复调度" : "暂停调度"}
					</Button>
				}
			/>
			<div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
				<span className="inline-flex items-center gap-1.5">
					<Radio className="size-3.5" aria-hidden="true" />
					<CandyBadge tone={board?.online ? "teal" : "gray"}>
						{board?.online ? "守护进程在线" : "守护进程离线"}
					</CandyBadge>
				</span>
				<span>本机授权：{cron?.enabled ? "已启用" : "未启用"}</span>
				<span>
					调度：{cron?.paused ? "已暂停" : "未暂停"}
					{board?.pausePending ? " · 等待确认" : ""}
				</span>
				<span className="text-basalt-muted-foreground">10 秒心跳 · 超过 45 秒标记离线</span>
			</div>
			{error ? (
				<p role="alert" className="text-sm text-basalt-destructive">
					{error}
				</p>
			) : null}
			{message ? (
				<p role="status" className="text-sm">
					{message}
				</p>
			) : null}
			{board?.errors.length ? (
				<p role="alert" className="text-sm text-basalt-destructive">
					{board.errors.join("；")}。无效数据未参与进度统计。
				</p>
			) : null}
			<div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
				<Metric label="执行中" value={board?.counts.active ?? 0} />
				<Metric label="前置条件阻塞" value={board?.counts.blocked ?? 0} />
				<Metric label="轮次耗尽" value={board?.counts.exhausted ?? 0} />
				<Metric label="已推送专用分支" value={board?.counts.pushed ?? 0} />
			</div>
			<div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
				<section className="min-w-0 space-y-3" aria-label="依赖修复任务">
					<div className="flex flex-wrap items-center gap-3">
						<SearchField label="搜索修复任务" value={query} onValueChange={setQuery} />
						<SelectField
							label="任务状态"
							value={filter}
							onValueChange={setFilter}
							options={[
								{ value: "all", label: "全部状态" },
								...Object.entries(STAGE_LABEL).map(([value, label]) => ({ value, label })),
							]}
						/>
						<span className="text-xs text-basalt-muted-foreground">
							{rows.length} 项 · 最多 20 轮，不会自动合并或发布
						</span>
					</div>
					{!rows.length ? (
						<LayerCard>
							<LayerCard.Empty
								icon={<Wrench />}
								title={data ? "暂无匹配的依赖修复任务" : "正在读取修复状态…"}
								description="需要本机配置仓库范围、明确检查脚本、已验证沙箱并启动守护进程。网页不能授权代码执行或推送。"
								action={
									<Button variant="secondary" size="sm" asChild>
										<Link href="/settings">查看 Agent 令牌设置</Link>
									</Button>
								}
							/>
						</LayerCard>
					) : (
						<div className="grid min-w-0 gap-3 lg:grid-cols-[15rem_minmax(0,1fr)]">
							<nav aria-label="选择修复任务" className="max-h-96 space-y-1 overflow-y-auto">
								{rows.map((row) => (
									<Button
										key={row.id}
										variant={job?.id === row.id ? "secondary" : "ghost"}
										className="h-auto w-full items-start justify-start whitespace-normal px-3 py-3 text-left"
										onClick={() => setSelected(row.id)}
										aria-pressed={job?.id === row.id}
									>
										<span className="min-w-0 space-y-1">
											<span className="block break-all text-xs text-basalt-muted-foreground">
												{row.repository} #{row.issueNumber}
											</span>
											<strong className="block text-sm">{row.title}</strong>
											<span className="flex flex-wrap items-center gap-2">
												<CandyBadge tone={tone(row.stage)}>{STAGE_LABEL[row.stage]}</CandyBadge>
												<span className="text-xs tabular-nums">
													{row.round}/{row.maxRounds} 轮
												</span>
											</span>
										</span>
									</Button>
								))}
							</nav>
							{job ? <RepairDetail key={job.id} job={job} now={now} /> : null}
						</div>
					)}
				</section>
				<aside className="min-w-0 space-y-3" aria-label="修复调度与权限">
					<LayerCard>
						<LayerCard.Header>
							<span className="inline-flex items-center gap-2">
								<Clock3 className="size-4" />
								持久调度
							</span>
						</LayerCard.Header>
						<LayerCard.Body className="space-y-3 text-xs">
							<dl className="space-y-3">
								<Info label="Cron" value={cron?.expression ?? "尚未上报"} />
								<Info label="时区" value={cron?.timezone ?? "未知"} />
								<Info
									label="下次运行"
									value={cron ? formatPreciseDate(cron.nextRunAt, cron.timezone) : "—"}
								/>
								<Info
									label="上次运行"
									value={cron ? formatPreciseDate(cron.lastRunAt, cron.timezone) : "—"}
								/>
								<Info
									label="最近心跳"
									value={
										cron
											? `${formatTimeAgo(cron.lastSeenAt, now, true)} · ${formatPreciseDate(cron.lastSeenAt)}`
											: "尚无心跳"
									}
								/>
								<Info label="已完成调度" value={String(cron?.completed ?? 0)} />
								{cron?.activeOccurrence ? (
									<Info label="当前调度 ID" value={cron.activeOccurrence} />
								) : null}
							</dl>
							{cron?.lastError ? (
								<p role="note" className="text-basalt-destructive">
									{cron.lastError}
								</p>
							) : null}
							{!cron || !board?.online ? (
								<p className="text-basalt-muted-foreground">
									请检查本机守护进程。离线不代表成功，也不会替你启用修复权限。
								</p>
							) : null}
						</LayerCard.Body>
					</LayerCard>
					<LayerCard>
						<LayerCard.Header>
							<span className="inline-flex items-center gap-2">
								<ShieldCheck className="size-4" />
								执行边界
							</span>
						</LayerCard.Header>
						<LayerCard.Body className="space-y-2 text-xs text-basalt-muted-foreground">
							<p>每个 Issue 独立 Sol 工作会话；专用 Astra reviewer 只对精确提交签核。</p>
							<p>先检查并提交，再审查。签核不等于推送；推送必须再次核对代码与检查凭证。</p>
							<p>仅推送 giraffe/deps-* 分支，不强推、不合并、不推默认分支、不发布版本。</p>
							<p>网页只能暂停／恢复调度；本机 profile、沙箱和 push 授权不能在这里修改。</p>
						</LayerCard.Body>
					</LayerCard>
				</aside>
			</div>
		</div>
	);
}
function Metric({ label, value }: { label: string; value: number }) {
	return (
		<LayerCard padding="sm">
			<div className="flex items-center justify-between gap-3">
				<span className="text-xs text-basalt-muted-foreground">{label}</span>
				<strong className="text-xl tabular-nums">{value}</strong>
			</div>
		</LayerCard>
	);
}
function Info({ label, value }: { label: string; value: string }) {
	return (
		<div className="space-y-1">
			<dt className="text-basalt-muted-foreground">{label}</dt>
			<dd className="break-all tabular-nums">{value}</dd>
		</div>
	);
}
function RepairDetail({ job, now }: { job: RepairProgress; now: number }) {
	const links = repairLinks(job);
	const exact = signoffMatches(job);
	const phase = REPAIR_PHASES.indexOf(job.stage);
	const review = job.review;
	return (
		<LayerCard className="min-w-0" data-testid="repair-detail">
			<LayerCard.Header>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<strong className="break-words">
						{job.repository} #{job.issueNumber}
					</strong>
					<CandyBadge tone={tone(job.stage)}>{STAGE_LABEL[job.stage]}</CandyBadge>
				</div>
			</LayerCard.Header>
			<LayerCard.Body className="space-y-4">
				<p className="text-sm font-medium">{job.title}</p>
				<ol aria-label="修复阶段" className="flex flex-wrap gap-x-3 gap-y-2 text-xs">
					{REPAIR_PHASES.map((value, index) => (
						<li
							key={value}
							className={`inline-flex items-center gap-1 ${phase >= index ? "text-basalt-foreground" : "text-basalt-muted-foreground"}`}
							aria-current={job.stage === value ? "step" : undefined}
						>
							<span className="tabular-nums">{index + 1}.</span>
							{STAGE_LABEL[value]}
						</li>
					))}
				</ol>
				<Meter
					value={(job.round / job.maxRounds) * 100}
					label="修复 / 审查轮次"
					customValue={`${job.round} / ${job.maxRounds}`}
				/>
				<p className="whitespace-pre-wrap break-words text-sm" role="status">
					{job.reason}
				</p>
				{job.stage === "blocked" ? (
					<p className="text-xs text-basalt-muted-foreground">
						前置条件未满足，没有执行成功承诺。请在本机检查 profile、沙箱、仓库来源和授权。
					</p>
				) : null}
				{job.stage === "exhausted" ? (
					<p className="text-xs text-basalt-destructive">
						已达到轮次上限，停止自动修复，需人工处理；没有签核不得推送。
					</p>
				) : null}
				<div className="flex flex-wrap gap-3 text-xs">
					{links.issue ? (
						<a
							href={links.issue}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1"
						>
							原始 Issue
							<ArrowUpRight className="size-3" />
						</a>
					) : null}
					{links.branch ? (
						<a
							href={links.branch}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1"
						>
							<GitBranch className="size-3" />
							专用分支
						</a>
					) : null}
					<span className="text-basalt-muted-foreground">
						状态 {formatTimeAgo(job.updatedAt, now, true)}
					</span>
				</div>
				{job.plan ? (
					<section className="space-y-1 text-xs" aria-label="依赖变更计划">
						<h3 className="text-sm font-semibold">计划变更</h3>
						<p className="break-all">
							{job.plan.manifest} · {job.plan.section}
						</p>
						<p>
							{job.plan.dependency} → {job.plan.targetVersion}
						</p>
						<p>{job.plan.reason}</p>
						<p className="text-basalt-muted-foreground">
							来源：{job.plan.provenance} · {job.plan.provenanceReason}
						</p>
					</section>
				) : null}
				<section className="space-y-2" aria-label="独立审查结果">
					<h3 className="text-sm font-semibold">独立审查</h3>
					{review ? (
						<>
							<div className="flex flex-wrap items-center gap-2">
								<CandyBadge tone={exact ? "teal" : review.verdict === "signoff" ? "amber" : "gray"}>
									{exact
										? "精确代码已签核"
										: review.verdict === "signoff"
											? "签核与当前代码不一致"
											: review.verdict === "changes_requested"
												? "要求修改"
												: "审查阻塞"}
								</CandyBadge>
								<span className="text-xs">第 {review.reviewedRound} 轮</span>
							</div>
							<p className="whitespace-pre-wrap text-sm">{review.summary}</p>
							{review.findings.map((finding, index) => (
								<div
									key={`${finding.path}:${finding.message}`}
									className="space-y-1 rounded bg-basalt-bright p-3 text-xs"
								>
									<strong>
										{index + 1}. {finding.severity} · {finding.path}
									</strong>
									<p className="whitespace-pre-wrap break-words">{finding.message}</p>
								</div>
							))}
							<dl className="space-y-2 text-xs">
								<Info label="审查 HEAD" value={review.head} />
								<Info label="审查内容指纹" value={review.contentFingerprint} />
								<Info label="检查凭证" value={review.validationDigest} />
							</dl>
						</>
					) : (
						<p className="text-xs text-basalt-muted-foreground">
							尚无 reviewer 签核。检查通过、代码提交和精确签核均不能省略。
						</p>
					)}
				</section>
				<details className="space-y-2">
					<summary className="cursor-pointer text-sm font-medium">提交与会话</summary>
					<dl className="space-y-2 text-xs">
						<Info label="当前 HEAD" value={job.head ?? "尚未提交"} />
						<Info label="当前内容指纹" value={job.contentFingerprint ?? "尚未捕获"} />
						<Info
							label="Sol 工作会话"
							value={
								job.workerConversationId === null ? "尚未创建" : String(job.workerConversationId)
							}
						/>
						<Info
							label="Astra 审查会话"
							value={
								job.reviewerConversationId === null
									? "尚未创建"
									: String(job.reviewerConversationId)
							}
						/>
						<Info label="任务 ID" value={job.id} />
					</dl>
				</details>
				<section className="space-y-2" aria-label="修复事件">
					<h3 className="text-sm font-semibold">
						实时事件{" "}
						<span className="font-normal text-basalt-muted-foreground">
							{job.events.length} / 80
						</span>
					</h3>
					<ol className="max-h-72 space-y-3 overflow-y-auto text-xs">
						{job.events.map((event) => (
							<li
								key={`${event.at}:${event.stage}:${event.round}:${event.message}`}
								className="space-y-1"
							>
								<p className="flex flex-wrap gap-2 text-basalt-muted-foreground">
									<time dateTime={event.at}>{formatPreciseDate(event.at)}</time>
									<span>
										第 {event.round} 轮 · {STAGE_LABEL[event.stage]}
									</span>
								</p>
								<p className="whitespace-pre-wrap break-words">{event.message}</p>
							</li>
						))}
					</ol>
					{!job.events.length ? (
						<p className="text-xs text-basalt-muted-foreground">等待下一条执行事件。</p>
					) : null}
				</section>
				<p className="text-xs text-basalt-muted-foreground">
					Issue、工具输出和审查文字仅作数据展示，不是执行指令。所有模型凭据只在本机。
				</p>
			</LayerCard.Body>
		</LayerCard>
	);
}
