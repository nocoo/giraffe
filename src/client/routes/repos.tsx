import { Button, SegmentControl, toast } from "@nocoo/basalt";
import { FilterBar } from "@nocoo/basalt/components/filter-bar";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import { Switch } from "@nocoo/basalt/components/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@nocoo/basalt/components/table";
import { Box, Star } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { participates } from "../../lib/repo-statistics";
import { CandyBadge } from "../components/layout/candy-badge";
import {
	ResultCount,
	SearchField,
	SnapshotTime,
	TableScroll,
} from "../components/layout/collection-chrome";
import { IconLabel } from "../components/layout/icon-label";
import { LanguageLabel } from "../components/layout/labels";
import {
	ActiveFilters,
	AgeStrip,
	Breakdown,
	OverviewCard,
} from "../components/layout/overview-cards";
import { TableSkeleton } from "../components/layout/page-skeleton";
import { ProjectSummary } from "../components/layout/project-identity";
import { ShareBar } from "../components/layout/rank-bars";
import { INLINE_SEGMENT } from "../components/layout/segment";
import { SnapshotPending } from "../components/layout/snapshot-pending";
import { Meter, SortButton } from "../components/layout/table-chrome";
import { categoryColor } from "../lib/chart-theme";
import { catchLoad, reportError } from "../lib/error-ui";
import {
	DATE_CELL,
	daysBetween,
	formatCount,
	formatDate,
	formatHealth,
	formatVisibility,
	freshnessFilled,
	freshnessTone,
	healthBadgeVariant,
	maxCount,
	meterFilled,
	NUM_CELL,
	NUM_HEAD,
	visibilityBadgeVariant,
} from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import { REPO_STATUS, reposBoard } from "../viewmodels/boards";
import { AGE_BUCKETS, shortRepo } from "../viewmodels/overview";
import {
	alertsIncomplete,
	healthMap,
	type InsightsSnapshot,
	loadInsightsOptional,
	loadRepos,
	type RepoRow,
	type ReposSnapshot,
	repoMetrics,
	type SortKey,
	saveRepoStatistics,
	type ViewMode,
	visibleRepos,
} from "../viewmodels/repos";

const NO_FILTERS = { language: "", status: "", age: "" };
const STATUS_COLORS = [
	"var(--color-basalt-chart-5)",
	"color-mix(in srgb,var(--color-basalt-chart-5) 35%,var(--color-basalt-border))",
	"var(--color-basalt-muted-foreground)",
	"var(--color-giraffe-yellow)",
];

export function ReposPage() {
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<SortKey>("stars");
	const [view, setView] = useState<ViewMode>("list");
	const [snap, setSnap] = useState<ReposSnapshot | { missing: true } | null>(null);
	const [insights, setInsights] = useState<InsightsSnapshot | null>(null);
	const [saving, setSaving] = useState<string | null>(null);
	const [picked, setPicked] = useState(NO_FILTERS);
	const pick = (key: keyof typeof NO_FILTERS) => (value: string) =>
		setPicked((old) => ({ ...old, [key]: value }));
	async function toggleStatistics(repo: RepoRow, enabled: boolean) {
		if (!snap || "missing" in snap || saving) return;
		const account = snap.account_id;
		setSaving(repo.name_with_owner);
		try {
			await saveRepoStatistics(account, repo, enabled);
			setSnap((current) =>
				current && !("missing" in current) && current.account_id === account
					? {
							...current,
							repos: current.repos.map((r) =>
								r.name_with_owner === repo.name_with_owner
									? { ...r, statistics_enabled: enabled }
									: r,
							),
						}
					: current,
			);
			setInsights(await loadInsightsOptional());
		} catch (err) {
			reportError(err);
		} finally {
			setSaving(null);
		}
	}
	const statisticsSwitch = (repo: RepoRow) => (
		<Switch
			size="sm"
			checked={participates(repo)}
			disabled={saving !== null}
			aria-label={`${repo.name_with_owner} 参与统计`}
			onCheckedChange={(enabled) => void toggleStatistics(repo, enabled)}
		/>
	);

	useEffect(() => {
		void loadRepos()
			.then(async (next) => {
				setSnap(next);
				if (!("missing" in next)) {
					setInsights(await loadInsightsOptional());
				} else {
					setInsights(null);
				}
			})
			.catch((err: unknown) => {
				const missing = catchLoad(err, (message) => {
					toast.error(message);
				});
				if (missing) {
					setSnap(missing);
					setInsights(null);
				}
			});
	}, []);

	const board = useMemo(
		() => (snap && !("missing" in snap) ? reposBoard(snap.repos, snap.fetched_at, picked) : null),
		[snap, picked],
	);
	const rows = useMemo(
		() => (board ? visibleRepos(board.rows, query, sort) : []),
		[board, query, sort],
	);
	const health = healthMap(insights);
	const incomplete = alertsIncomplete(insights);
	const peakIssues = maxCount(rows.map((row) => row.open_issue_count));
	const actions = (
		<>
			{snap && !("missing" in snap) ? <SnapshotTime fetchedAt={snap.fetched_at} /> : null}
			{snap && !("missing" in snap) && snap.truncated ? (
				<CandyBadge tone="amber">已截断</CandyBadge>
			) : null}
			{incomplete ? (
				<span role="note" className="text-xs text-basalt-muted-foreground">
					可选安全告警未完整获取
				</span>
			) : null}
		</>
	);

	const filters = (
		<FilterBar label="仓库 筛选" className="w-full">
			<SearchField
				value={query}
				onValueChange={setQuery}
				label="搜索仓库"
				placeholder="搜索仓库名称或描述"
			/>
			<SegmentControl
				legend="排序"
				className={INLINE_SEGMENT}
				value={sort}
				onValueChange={(value) => setSort(value as SortKey)}
				options={[
					{ value: "stars", label: "Stars" },
					{ value: "pushed", label: "最近推送" },
					{ value: "name", label: "名称" },
				]}
			/>
		</FilterBar>
	);

	if (snap && "missing" in snap) {
		return (
			<div className="space-y-8">
				<PageHeader title="仓库" description={PAGE_DESCRIPTIONS["/"]} />
				<LayerCard>
					<LayerCard.Well>
						<SnapshotPending state={snap} />
					</LayerCard.Well>
				</LayerCard>
			</div>
		);
	}

	if (!snap) {
		return (
			<div className="space-y-8">
				<PageHeader title="仓库" description={PAGE_DESCRIPTIONS["/"]} />
				<TableSkeleton label="加载仓库" columns={8} />
			</div>
		);
	}

	const metrics = repoMetrics(snap.repos);
	if (!board) return null;

	return (
		<div className="giraffe-page-motion space-y-6">
			<PageHeader
				title="仓库"
				description={PAGE_DESCRIPTIONS["/"]}
				actions={actions}
				filters={filters}
			/>
			<div className="giraffe-stat-inline" data-testid="repo-summary">
				<span>
					<strong>{formatCount(snap.repos.length)}</strong>个仓库 · 其中{" "}
					<strong>{formatCount(metrics.count)}</strong>个参与统计
				</span>
				<span>
					<strong>{formatCount(board.privateCount)}</strong>个私有
				</span>
				<span>
					参与统计的 Stars <strong>{formatCount(metrics.stars)}</strong>· Forks{" "}
					<strong>{formatCount(metrics.forks)}</strong>· Open Issues{" "}
					<strong>{formatCount(metrics.issues)}</strong>
				</span>
			</div>
			<div className="giraffe-overview" style={{ "--cols": 4 } as CSSProperties}>
				<OverviewCard
					title="仓库构成"
					hint="按参与统计、已排除、Fork 与已归档分组，点击下方状态筛选。"
				>
					<ShareBar
						label="仓库构成"
						legend={false}
						parts={board.status.map((st, i) => ({
							key: st.key,
							label: st.label,
							value: st.value,
							color: STATUS_COLORS[i] ?? "var(--color-basalt-border)",
						}))}
					/>
					<div className="mt-4">
						<Breakdown
							rows={board.status.map((st, i) => ({
								name: st.key,
								value: st.value,
								share: st.value / Math.max(1, board.rows.length),
								color: STATUS_COLORS[i] ?? "var(--color-basalt-border)",
							}))}
							max={Math.max(1, ...board.status.map((st) => st.value))}
							label="仓库按状态"
							active={picked.status}
							onSelect={pick("status")}
							format={(k) => REPO_STATUS.find((st) => st.key === k)?.label ?? k}
						/>
					</div>
				</OverviewCard>
				<OverviewCard title="最近推送" hint="距最近一次推送的天数，点击筛选。越靠右越久未动。">
					<AgeStrip
						age={board.freshness}
						active={picked.age}
						onSelect={pick("age")}
						label="仓库最近推送分布"
					/>
				</OverviewCard>
				<OverviewCard
					title="主语言"
					hint="按 GitHub 主语言统计仓库数，颜色与全站语言色一致。点击筛选。"
				>
					<Breakdown
						rows={board.languages.rows.map((r) => ({ ...r, color: categoryColor(r.name) }))}
						max={board.languages.max}
						label="仓库按主语言"
						active={picked.language}
						onSelect={pick("language")}
					/>
				</OverviewCard>
				<OverviewCard title="Stars 最多" hint="当前筛选下 Stars 最多的仓库。">
					<Breakdown
						rows={board.stars.rows}
						max={board.stars.max}
						label="Stars 最多的仓库"
						active=""
						format={shortRepo}
						color="var(--color-giraffe-yellow)"
					/>
				</OverviewCard>
			</div>
			<ActiveFilters
				filters={picked}
				labels={{ status: "状态", age: "最近推送", language: "语言" }}
				format={{
					status: (k) => REPO_STATUS.find((st) => st.key === k)?.label ?? k,
					age: (k) => AGE_BUCKETS.find((b) => b.key === k)?.label ?? k,
				}}
				onClear={(key) => setPicked((old) => (key ? { ...old, [key]: "" } : NO_FILTERS))}
			/>
			<SectionRule
				title={<IconLabel icon={Box}>仓库</IconLabel>}
				actions={
					<>
						<ResultCount count={rows.length} total={snap.repos.length} />
						<SegmentControl
							legend="视图"
							className={INLINE_SEGMENT}
							value={view}
							onValueChange={(value) => setView(value as ViewMode)}
							options={[
								{ value: "list", label: "列表" },
								{ value: "grid", label: "网格" },
							]}
						/>
					</>
				}
			>
				<p className="mb-3 text-xs text-basalt-muted-foreground">
					参与统计的设置全局生效，包含软件工厂。Fork 和已归档仓库默认关闭，可随时修改。
				</p>
				{rows.length === 0 ? (
					<LayerCard>
						<LayerCard.Well>
							<LayerCard.Empty
								icon={<Box />}
								title={query.trim() ? "没有匹配结果" : "还没有仓库"}
								description={
									query.trim()
										? "试试其他关键词，或清除搜索查看全部内容。"
										: "最近一次统一更新中没有相关内容。"
								}
								action={
									query.trim() ? (
										<Button variant="secondary" size="sm" onClick={() => setQuery("")}>
											清除搜索
										</Button>
									) : undefined
								}
							/>
						</LayerCard.Well>
					</LayerCard>
				) : view === "grid" ? (
					<div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="repo-list">
						{rows.map((row) => {
							const status = health.get(row.name_with_owner);
							return (
								<div
									key={row.name_with_owner}
									className="min-w-0 rounded-basalt-lg text-basalt-foreground no-underline hover:no-underline"
								>
									<LayerCard
										padding="md"
										className="flex h-full min-w-0 flex-col transition-shadow hover:ring-1 hover:ring-basalt-border"
									>
										<div className="flex items-start justify-between gap-2">
											{statisticsSwitch(row)}
											<ProjectSummary
												repo={row.name_with_owner}
												description={row.description}
												card
											/>
											{status ? (
												<CandyBadge tone={healthBadgeVariant(status)}>
													{formatHealth(status)}
												</CandyBadge>
											) : null}
										</div>

										<div className="mt-auto flex flex-wrap items-center gap-2 pt-4 text-xs text-basalt-muted-foreground">
											<LanguageLabel name={row.primary_language} />
											<span>·</span>
											<span className="inline-flex items-center gap-1 tabular-nums">
												<Star className="size-3 text-basalt-primary" strokeWidth={1.5} />
												{formatCount(row.stargazer_count)}
											</span>
											<CandyBadge tone={visibilityBadgeVariant(row.visibility)}>
												{formatVisibility(row.visibility)}
											</CandyBadge>
											{row.is_archived ? <CandyBadge tone="orange">归档</CandyBadge> : null}
											{row.is_fork ? <CandyBadge tone="teal">Fork</CandyBadge> : null}
										</div>
										<p className="mt-3 text-xs tabular-nums text-basalt-muted-foreground">
											推送于 {formatDate(row.pushed_at)}
										</p>
									</LayerCard>
								</div>
							);
						})}
					</div>
				) : (
					<LayerCard>
						<LayerCard.Well className="p-0">
							<TableScroll label="仓库列表">
								<Table className="giraffe-data-table min-w-[900px]" data-testid="repo-list">
									<TableHeader>
										<TableRow>
											<TableHead>参与统计</TableHead>
											<TableHead data-grow>
												<SortButton
													label="仓库"
													active={sort === "name"}
													direction="asc"
													onClick={() => setSort("name")}
												/>
											</TableHead>

											<TableHead>语言</TableHead>
											<TableHead>状态</TableHead>
											<TableHead className={NUM_HEAD}>
												<SortButton
													label="Stars"
													active={sort === "stars"}
													onClick={() => setSort("stars")}
												/>
											</TableHead>
											<TableHead className={NUM_HEAD}>Fork</TableHead>
											<TableHead className={NUM_HEAD}>Issues</TableHead>

											<TableHead className={NUM_HEAD}>
												<SortButton
													label="最近推送"
													active={sort === "pushed"}
													onClick={() => setSort("pushed")}
												/>
											</TableHead>
											{health.size > 0 ? <TableHead>健康</TableHead> : null}
										</TableRow>
									</TableHeader>
									<TableBody>
										{rows.map((row) => {
											const status = health.get(row.name_with_owner);
											const days = daysBetween(snap.fetched_at, row.pushed_at);
											return (
												<TableRow key={row.name_with_owner}>
													<TableCell>{statisticsSwitch(row)}</TableCell>
													<TableCell className="w-full min-w-72 max-w-0">
														<ProjectSummary
															repo={row.name_with_owner}
															description={row.description}
															badges={
																row.is_fork ? <CandyBadge tone="teal">Fork</CandyBadge> : null
															}
														/>
													</TableCell>
													<TableCell>
														<LanguageLabel name={row.primary_language} />
													</TableCell>
													<TableCell>
														<div className="flex items-center gap-1.5">
															<CandyBadge tone={visibilityBadgeVariant(row.visibility)}>
																{formatVisibility(row.visibility)}
															</CandyBadge>
															{row.is_archived ? (
																<CandyBadge tone="orange">已归档</CandyBadge>
															) : null}
														</div>
													</TableCell>
													<TableCell className={NUM_CELL}>
														{formatCount(row.stargazer_count)}
													</TableCell>
													<TableCell className={NUM_CELL}>{formatCount(row.fork_count)}</TableCell>
													<TableCell>
														<div className="flex items-center justify-end gap-2">
															<Meter
																filled={meterFilled(row.open_issue_count, peakIssues)}
																tone="bg-basalt-chart-1"
																label={`${row.name_with_owner} issues`}
															/>
															<span className={NUM_CELL}>{formatCount(row.open_issue_count)}</span>
														</div>
													</TableCell>
													<TableCell className={DATE_CELL}>
														<div className="flex items-center justify-end gap-2">
															<Meter
																filled={freshnessFilled(days)}
																tone={freshnessTone(days)}
																label={`${row.name_with_owner} activity`}
															/>
															<time
																dateTime={row.pushed_at ?? undefined}
																title={formatDate(row.pushed_at)}
															>
																{formatDate(row.pushed_at).slice(0, 10)}
															</time>
														</div>
													</TableCell>
													{health.size > 0 ? (
														<TableCell>
															{status ? (
																<CandyBadge tone={healthBadgeVariant(status)}>
																	{formatHealth(status)}
																</CandyBadge>
															) : (
																"—"
															)}
														</TableCell>
													) : null}
												</TableRow>
											);
										})}
									</TableBody>
								</Table>
							</TableScroll>
						</LayerCard.Well>
					</LayerCard>
				)}
			</SectionRule>
		</div>
	);
}
