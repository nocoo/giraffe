import { Button, Link, SegmentControl, toast } from "@nocoo/basalt";
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
import { Box, CircleDot, Clock3, GitFork, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { participates } from "../../lib/repo-statistics";
import { CandyBadge } from "../components/layout/candy-badge";
import { ResultCount, SearchField, TableScroll } from "../components/layout/collection-chrome";
import { Kpi, KpiRow } from "../components/layout/kpi";
import { LanguageLabel } from "../components/layout/labels";
import { TableSkeleton } from "../components/layout/page-skeleton";
import { INLINE_SEGMENT } from "../components/layout/segment";
import { SnapshotPending } from "../components/layout/snapshot-pending";
import { Meter, SortButton } from "../components/layout/table-chrome";
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

export function ReposPage() {
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<SortKey>("stars");
	const [view, setView] = useState<ViewMode>("list");
	const [snap, setSnap] = useState<ReposSnapshot | { missing: true } | null>(null);
	const [insights, setInsights] = useState<InsightsSnapshot | null>(null);
	const [saving, setSaving] = useState<string | null>(null);
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

	const rows = useMemo(() => {
		if (!snap || "missing" in snap) {
			return [];
		}
		return visibleRepos(snap.repos, query, sort);
	}, [snap, query, sort]);
	const health = healthMap(insights);
	const incomplete = alertsIncomplete(insights);
	const peakIssues = maxCount(rows.map((row) => row.open_issue_count));
	const actions = (
		<>
			{snap && !("missing" in snap) ? (
				<span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-basalt-muted-foreground">
					<Clock3 className="size-3.5" aria-hidden="true" />
					数据更新于 <time dateTime={snap.fetched_at}>{formatDate(snap.fetched_at)}</time>
				</span>
			) : null}
			{snap && !("missing" in snap) && snap.truncated ? (
				<CandyBadge tone="amber">已截断</CandyBadge>
			) : null}
			{incomplete ? <CandyBadge tone="orange">告警不完整</CandyBadge> : null}
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

	return (
		<div className="space-y-8">
			<PageHeader
				title="仓库"
				description={PAGE_DESCRIPTIONS["/"]}
				actions={actions}
				filters={filters}
			/>
			<KpiRow>
				<Kpi icon={Box} label="参与统计的仓库" value={formatCount(metrics.count)} />
				<Kpi icon={Star} label="Stars" value={formatCount(metrics.stars)} />
				<Kpi icon={GitFork} label="Forks" value={formatCount(metrics.forks)} />
				<Kpi icon={CircleDot} label="Issues" value={formatCount(metrics.issues)} />
			</KpiRow>
			<SectionRule
				title="仓库"
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
											<Link
												href={`/repos/${row.owner_login}/${row.name}`}
												className="min-w-0 truncate text-base font-semibold"
												title={row.name_with_owner}
											>
												{row.name_with_owner}
											</Link>
											{status ? (
												<CandyBadge tone={healthBadgeVariant(status)}>
													{formatHealth(status)}
												</CandyBadge>
											) : null}
										</div>
										<p className="mt-2 mb-4 min-h-10 line-clamp-2 text-sm leading-5 text-basalt-muted-foreground">
											{row.description ?? "没有描述"}
										</p>
										<div className="mt-auto flex flex-wrap items-center gap-2 text-xs text-basalt-muted-foreground">
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
								<Table className="min-w-[880px] [&_th]:whitespace-nowrap" data-testid="repo-list">
									<TableHeader>
										<TableRow>
											<TableHead>参与统计</TableHead>
											<TableHead>
												<SortButton
													label="仓库"
													active={sort === "name"}
													direction="asc"
													onClick={() => setSort("name")}
												/>
											</TableHead>

											<TableHead>语言</TableHead>
											<TableHead>可见性</TableHead>
											<TableHead>归档</TableHead>
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
													<TableCell className="min-w-64 max-w-sm">
														<Link
															href={`/repos/${row.owner_login}/${row.name}`}
															className="font-medium text-basalt-foreground [overflow-wrap:anywhere] hover:text-basalt-primary"
														>
															{row.name_with_owner}
														</Link>
														{row.description ? (
															<p
																className="mt-1 line-clamp-1 text-xs text-basalt-muted-foreground"
																title={row.description}
															>
																{row.description}
															</p>
														) : null}
														<div className="mt-2 flex flex-wrap gap-1">
															{row.is_fork ? <CandyBadge tone="teal">Fork</CandyBadge> : null}
														</div>
													</TableCell>
													<TableCell>
														<LanguageLabel name={row.primary_language} />
													</TableCell>
													<TableCell>
														<CandyBadge tone={visibilityBadgeVariant(row.visibility)}>
															{formatVisibility(row.visibility)}
														</CandyBadge>
													</TableCell>
													<TableCell>
														{row.is_archived ? (
															<CandyBadge tone="orange">已归档</CandyBadge>
														) : (
															<span className="text-basalt-muted-foreground">—</span>
														)}
													</TableCell>
													<TableCell className={NUM_CELL}>
														{formatCount(row.stargazer_count)}
													</TableCell>
													<TableCell className={NUM_CELL}>{formatCount(row.fork_count)}</TableCell>
													<TableCell>
														<div className="flex items-center justify-end gap-2">
															<Meter
																filled={meterFilled(row.open_issue_count, peakIssues)}
																tone="bg-basalt-primary"
																label={`${row.name_with_owner} issues`}
															/>
															<span className={NUM_CELL}>{formatCount(row.open_issue_count)}</span>
														</div>
													</TableCell>
													<TableCell className={DATE_CELL}>
														<time dateTime={row.pushed_at ?? undefined}>
															{formatDate(row.pushed_at)}
														</time>
														<div className="mt-2 flex justify-end">
															<Meter
																filled={freshnessFilled(days)}
																tone={freshnessTone(days)}
																label={`${row.name_with_owner} activity`}
															/>
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
