import { Link, SegmentControl, toast } from "@nocoo/basalt";
import { FilterBar } from "@nocoo/basalt/components/filter-bar";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@nocoo/basalt/components/table";
import { ArrowUpRight, CircleAlert, Eye, ShieldCheck, Tag, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CiReportResponse } from "../../lib/ci-health";
import { CandyBadge } from "../components/layout/candy-badge";
import { ChartBrick } from "../components/layout/chart-brick";
import {
	SearchField,
	SnapshotDescription,
	TableScroll,
} from "../components/layout/collection-chrome";
import { IconLabel } from "../components/layout/icon-label";
import { CountBars } from "../components/layout/overview-cards";
import { CiSkeleton } from "../components/layout/page-skeleton";
import { ProjectLink } from "../components/layout/project-identity";
import { ShareBar } from "../components/layout/rank-bars";
import { INLINE_SEGMENT } from "../components/layout/segment";
import { SnapshotPending } from "../components/layout/snapshot-pending";
import { catchLoad } from "../lib/error-ui";
import { DATE_CELL, formatCount, formatDate, NUM_CELL, NUM_HEAD } from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import {
	type CiStream,
	ciBuckets,
	ciFilterStreams,
	loadCi,
	releaseRows,
	runSummary,
	runTimeline,
} from "../viewmodels/ci";
import { daysAgo } from "../viewmodels/overview";

const VERDICT = {
	broken: { label: "连续失败", tone: "red", color: "hsl(var(--basalt-accent-8))" },
	flaky: { label: "偶发失败", tone: "amber", color: "var(--color-giraffe-yellow)" },
	healthy: { label: "稳定", tone: "green", color: "var(--color-basalt-chart-5)" },
	idle: { label: "无近期运行", tone: "gray", color: "var(--color-basalt-border)" },
	none: { label: "无工作流", tone: "gray", color: "var(--color-basalt-border)" },
} as const;
const OUTCOME_COLOR = {
	success: "var(--color-basalt-chart-5)",
	failure: "hsl(var(--basalt-accent-8))",
	other: "var(--color-basalt-muted-foreground)",
	pending: "var(--color-giraffe-yellow)",
};

export function CiPage() {
	const [snap, setSnap] = useState<CiReportResponse | { missing: true } | null>(null);
	const [filters, setFilters] = useState({ verdict: "", repo: "", query: "" });
	useEffect(() => {
		void loadCi()
			.then(setSnap)
			.catch((err: unknown) => {
				const missing = catchLoad(err, (message) => toast.error(message));
				if (missing) setSnap(missing);
			});
	}, []);
	const report = snap && !("missing" in snap) ? snap : null;
	const buckets = useMemo(() => (report ? ciBuckets(report.streams) : null), [report]);
	const streams = useMemo(
		() =>
			report
				? ciFilterStreams(
						report.streams.filter((s) => s.scope !== "bot"),
						filters,
					)
				: [],
		[report, filters],
	);
	const releases = useMemo(() => (report ? releaseRows(report.repos) : []), [report]);

	if (snap && "missing" in snap)
		return (
			<div className="space-y-8">
				<PageHeader title="CI 与发布" description={PAGE_DESCRIPTIONS["/ci"]} />
				<LayerCard>
					<LayerCard.Well>
						<SnapshotPending state={snap} />
					</LayerCard.Well>
				</LayerCard>
			</div>
		);
	if (!report || !buckets)
		return (
			<div className="space-y-8">
				<PageHeader title="CI 与发布" description={PAGE_DESCRIPTIONS["/ci"]} />
				<CiSkeleton label="加载 CI 状态" />
			</div>
		);

	const t = report.totals;
	const recurring = buckets.watch.filter((s) => s.recurring);
	const oneOff = buckets.watch.filter((s) => !s.recurring);
	return (
		<div className="giraffe-page-motion space-y-6">
			<PageHeader
				title="CI 与发布"
				description={
					<SnapshotDescription
						description={PAGE_DESCRIPTIONS["/ci"]}
						fetchedAt={report.fetched_at}
					/>
				}
				actions={
					<>
						{t.truncated ? (
							<CandyBadge tone="amber">{t.truncated} 个仓库运行记录已截断</CandyBadge>
						) : null}
						{report.unsaved.length ? (
							<CandyBadge tone="gray">{report.unsaved.length} 个仓库未采集</CandyBadge>
						) : null}
					</>
				}
			/>
			<section className="giraffe-ci-summary" aria-label="CI 判定汇总" data-testid="ci-summary">
				<ShareBar
					label="工作流判定"
					legend={false}
					parts={(["broken", "flaky", "healthy", "idle"] as const).map((k) => ({
						key: k,
						label: VERDICT[k].label,
						value: t[k],
						color: VERDICT[k].color,
					}))}
				/>
				<dl>
					<Tile
						icon={CircleAlert}
						tone="broken"
						label="需要处理"
						value={t.broken}
						note="连续 ≥2 次失败"
					/>
					<Tile
						icon={Eye}
						tone="flaky"
						label="继续观察"
						value={t.flaky}
						note={`其中 ${t.recurring} 个反复失败`}
					/>
					<Tile
						icon={ShieldCheck}
						tone="healthy"
						label="稳定"
						value={t.healthy}
						note="近 10 次全部成功"
					/>
					<Tile
						icon={Workflow}
						tone="idle"
						label="无近期运行"
						value={t.idle}
						note="30 天内无判定结果"
					/>
				</dl>
				<p>
					按「工作流 ×
					分支」判定：默认分支和版本标签归为一条线，活跃的功能分支仅在失败时列出，Dependabot
					更新任务单独统计（{formatCount(t.bot)} 条），不影响仓库结论。基准时间{" "}
					{formatDate(report.now)}。
				</p>
			</section>

			<SectionRule
				title={<IconLabel icon={CircleAlert}>需要处理</IconLabel>}
				hint="两种情况：最近至少连续 2 次失败，最后一次成功后再没通过；或近 4 次以上判定中失败过半，偶尔通过也不算恢复。"
			>
				{buckets.act.length ? (
					<ul className="giraffe-ci-cards">
						{buckets.act.map((s) => (
							<StreamCard key={`${s.repo}:${s.workflow}:${s.branch}`} s={s} now={report.now} />
						))}
					</ul>
				) : (
					<p className="giraffe-ci-clear" role="status">
						没有连续失败的工作流。
					</p>
				)}
			</SectionRule>

			<div className="giraffe-overview" style={{ "--cols": 2 } as React.CSSProperties}>
				<ChartBrick
					title="继续观察"
					description="有失败但最近又恢复成功。反复失败：近 10 次判定失败超过 1 次；偶发：只失败 1 次。"
				>
					<WatchList title={`反复失败 · ${recurring.length}`} items={recurring} now={report.now} />
					<WatchList title={`偶发一次 · ${oneOff.length}`} items={oneOff} now={report.now} muted />
				</ChartBrick>
				<ChartBrick
					title="近 30 天运行结果"
					description="全部仓库每日运行按结果堆叠，不含 Dependabot 更新任务。"
				>
					<CountBars
						data={report.daily}
						series={[
							{ key: "success", label: "成功", color: OUTCOME_COLOR.success },
							{ key: "failure", label: "失败", color: OUTCOME_COLOR.failure },
							{ key: "other", label: "取消 / 跳过", color: OUTCOME_COLOR.other },
						]}
						label="近 30 天运行结果"
						xFormat={(v) => v.slice(5)}
						className="h-56 w-full"
					/>
				</ChartBrick>
			</div>

			<SectionRule
				title={<IconLabel icon={Workflow}>全部工作流</IconLabel>}
				hint="每行一条工作流线。方块为最近 10 次运行，从左到右由旧到新，最右侧加框的一格是最新一次。"
				actions={
					<FilterBar label="工作流筛选">
						<SearchField
							value={filters.query}
							onValueChange={(query) => setFilters((f) => ({ ...f, query }))}
							label="搜索工作流"
							placeholder="仓库、工作流或分支"
						/>
						<SegmentControl
							legend="判定"
							className={INLINE_SEGMENT}
							value={filters.verdict || "all"}
							onValueChange={(v) => setFilters((f) => ({ ...f, verdict: v === "all" ? "" : v }))}
							options={[
								{ value: "all", label: "全部" },
								{ value: "broken", label: "连续失败" },
								{ value: "recurring", label: "反复失败" },
								{ value: "flaky", label: "偶发" },
								{ value: "healthy", label: "稳定" },
							]}
						/>
					</FilterBar>
				}
			>
				<LayerCard>
					<LayerCard.Well className="p-0">
						<TableScroll label="工作流列表">
							<Table className="giraffe-data-table min-w-[860px]" data-testid="ci-list">
								<TableHeader>
									<TableRow>
										<TableHead data-grow>仓库 / 工作流</TableHead>
										<TableHead>判定</TableHead>
										<TableHead>最近 10 次 · 旧 → 新</TableHead>
										<TableHead className={NUM_HEAD}>成功率</TableHead>
										<TableHead className={NUM_HEAD}>最后成功</TableHead>
										<TableHead className={NUM_HEAD}>最后运行</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{streams.map((s) => (
										<TableRow key={`${s.repo}:${s.workflow}:${s.branch}`}>
											<TableCell>
												<ProjectLink repo={s.repo} className="font-medium text-basalt-foreground" />
												<div className="text-xs text-basalt-muted-foreground">
													{s.workflow}
													{s.scope === "branch" ? ` · ${s.branch}` : ""}
												</div>
											</TableCell>
											<TableCell>
												<CandyBadge tone={VERDICT[s.verdict].tone}>
													{VERDICT[s.verdict].label}
												</CandyBadge>
												<div className="mt-1 text-xs text-basalt-muted-foreground">{s.reason}</div>
											</TableCell>
											<TableCell>
												<RunStrip s={s} />
											</TableCell>
											<TableCell className={NUM_CELL}>
												{s.rate === null ? "—" : `${Math.round(s.rate * 100)}%`}
											</TableCell>
											<TableCell className={DATE_CELL}>{ago(s.lastSuccess, report.now)}</TableCell>
											<TableCell className={DATE_CELL}>{ago(s.lastRun, report.now)}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</TableScroll>
						{streams.length ? null : (
							<LayerCard.Empty
								icon={<Workflow />}
								title="没有符合筛选的工作流"
								description="调整筛选条件后再试。"
							/>
						)}
					</LayerCard.Well>
				</LayerCard>
			</SectionRule>

			<SectionRule
				title={<IconLabel icon={Tag}>发布</IconLabel>}
				hint="按发布流水线状态和距最近版本的时间排序。超过 3 个典型间隔（或 90 天）未发布标记为久未发布。"
			>
				<LayerCard>
					<LayerCard.Well className="p-0">
						<TableScroll label="发布列表">
							<Table className="giraffe-data-table min-w-[720px]" data-testid="release-list">
								<TableHeader>
									<TableRow>
										<TableHead data-grow>仓库</TableHead>
										<TableHead>最新版本</TableHead>
										<TableHead>发布流水线</TableHead>
										<TableHead className={NUM_HEAD}>距今</TableHead>
										<TableHead className={NUM_HEAD}>间隔中位</TableHead>
										<TableHead className={NUM_HEAD}>30 天发布</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{releases.map((r) => (
										<TableRow key={r.repo}>
											<TableCell>
												<ProjectLink repo={r.repo} className="font-medium text-basalt-foreground" />
											</TableCell>
											<TableCell>
												{r.latest ?? <span className="text-basalt-muted-foreground">从未发布</span>}
											</TableCell>
											<TableCell>
												{r.pipeline === "none" ? (
													<span className="text-basalt-muted-foreground">无发布工作流</span>
												) : (
													<CandyBadge tone={VERDICT[r.pipeline].tone}>
														{VERDICT[r.pipeline].label}
														{r.pipelineStreak > 1 ? ` · ${r.pipelineStreak} 次` : ""}
													</CandyBadge>
												)}
											</TableCell>
											<TableCell className={NUM_CELL}>
												{r.ageDays === null ? "—" : `${r.ageDays} 天`}
												{r.stale ? <span className="giraffe-ci-stale">久未发布</span> : null}
											</TableCell>
											<TableCell className={NUM_CELL}>
												{r.cadenceDays === null ? "—" : `${r.cadenceDays} 天`}
											</TableCell>
											<TableCell className={NUM_CELL}>{formatCount(r.recent30)}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</TableScroll>
					</LayerCard.Well>
				</LayerCard>
			</SectionRule>
		</div>
	);
}

function ago(at: string | null, now: string): string {
	const d = daysAgo(at, now);
	return d === null ? "—" : d === 0 ? "今天" : `${d} 天前`;
}

function Tile({
	icon: Icon,
	tone,
	label,
	value,
	note,
}: {
	icon: typeof Workflow;
	tone: keyof typeof VERDICT;
	label: string;
	value: number;
	note: string;
}) {
	return (
		<div data-tone={tone}>
			<dt>
				<Icon className="size-4" aria-hidden="true" />
				{label}
			</dt>
			<dd>
				<strong>{formatCount(value)}</strong>
				<small>{note}</small>
			</dd>
		</div>
	);
}

function RunStrip({ s, axis = false }: { s: CiStream; axis?: boolean }) {
	const cells = runTimeline(s.recent);
	return (
		<span className="giraffe-run-strip" data-axis={axis || undefined}>
			<span className="giraffe-run-cells" role="img" aria-label={runSummary(cells)}>
				{cells.map((c) => (
					<i
						key={c.id}
						data-latest={c.latest || undefined}
						style={{ background: OUTCOME_COLOR[c.outcome] }}
						title={c.label}
					/>
				))}
			</span>
			{axis && cells.length ? (
				<span className="giraffe-run-axis" aria-hidden="true">
					<span>旧</span>
					<span>最新</span>
				</span>
			) : null}
		</span>
	);
}

function StreamCard({ s, now }: { s: CiStream; now: string }) {
	return (
		<li>
			<LayerCard padding="md" className="giraffe-ci-card">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<ProjectLink repo={s.repo} className="font-semibold text-basalt-foreground" />
						<p className="text-xs text-basalt-muted-foreground">
							{s.workflow} · {s.branch}
						</p>
					</div>
					<CandyBadge tone="red">
						{s.brokenBy === "streak" ? `连续 ${s.streak} 次` : `${s.failures}/${s.decided} 失败`}
					</CandyBadge>
				</div>
				<RunStrip s={s} axis />
				<p className="giraffe-stat-inline">
					{s.brokenBy === "streak" ? (
						<span>
							失败始于 <strong>{ago(s.failingSince, now)}</strong>
						</span>
					) : (
						<span>
							成功率 <strong>{s.rate === null ? "—" : `${Math.round(s.rate * 100)}%`}</strong>
						</span>
					)}
					<span>
						最后成功 <strong>{ago(s.lastSuccess, now)}</strong>
					</span>
				</p>
				<Link
					href={`https://github.com/${s.repo}/actions?query=${encodeURIComponent(`workflow:"${s.workflow}"`)}`}
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-1 text-xs"
				>
					在 GitHub 查看运行 <ArrowUpRight className="size-3" aria-hidden="true" />
				</Link>
			</LayerCard>
		</li>
	);
}

function WatchList({
	title,
	items,
	now,
	muted = false,
}: {
	title: string;
	items: CiStream[];
	now: string;
	muted?: boolean;
}) {
	return (
		<div className="giraffe-watch" data-muted={muted || undefined}>
			<h3>
				{title}
				<span className="giraffe-watch-order">方块 旧 → 新</span>
			</h3>
			{items.length ? (
				<ul>
					{items.slice(0, 12).map((s) => (
						<li key={`${s.repo}:${s.workflow}:${s.branch}`}>
							<div className="giraffe-watch-name">
								<ProjectLink repo={s.repo} />
								<small>{s.workflow}</small>
							</div>
							<RunStrip s={s} />
							<span className="giraffe-watch-meta">
								{s.failures}/{s.decided} · {ago(s.lastRun, now)}
							</span>
						</li>
					))}
				</ul>
			) : (
				<p className="text-xs text-basalt-muted-foreground">无</p>
			)}
			{items.length > 12 ? (
				<p className="text-xs text-basalt-muted-foreground">
					另有 {items.length - 12} 条，见下方全部工作流。
				</p>
			) : null}
		</div>
	);
}
