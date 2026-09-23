import { Button, Link, SegmentControl, toast } from "@nocoo/basalt";
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
import { GitPullRequest } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CandyBadge } from "../components/layout/candy-badge";
import {
	ResultCount,
	SearchField,
	SnapshotDescription,
	TableScroll,
} from "../components/layout/collection-chrome";
import {
	ActiveFilters,
	AgeStrip,
	Breakdown,
	CountBars,
	OverviewCard,
} from "../components/layout/overview-cards";
import { TableSkeleton } from "../components/layout/page-skeleton";
import { ShareBar } from "../components/layout/rank-bars";
import { INLINE_SEGMENT } from "../components/layout/segment";
import { SnapshotPending } from "../components/layout/snapshot-pending";
import { ChurnMeter, PersonCell, SortButton } from "../components/layout/table-chrome";
import { chartColor, FLOW_COLORS } from "../lib/chart-theme";
import { catchLoad } from "../lib/error-ui";
import {
	churnFilled,
	DATE_CELL,
	formatCount,
	formatDate,
	formatReview,
	NUM_CELL,
	NUM_HEAD,
	reviewBadgeVariant,
} from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import {
	mergedHistory,
	PR_SIZES,
	pullsBoard,
	REVIEW_STATES,
	type WorkFilters,
} from "../viewmodels/boards";
import { loadFactory } from "../viewmodels/factory";
import { AGE_BUCKETS, shortRepo } from "../viewmodels/overview";
import { loadPulls, type PullSort, type PullsSnapshot, visiblePulls } from "../viewmodels/pulls";

type PullFilters = WorkFilters & { review: string };
const NO_FILTERS: PullFilters = { repo: "", label: "", author: "", age: "", review: "" };
const FILTER_LABELS = { repo: "仓库", author: "作者", age: "年龄", review: "审查" };
const REVIEW_COLORS = {
	draft: "var(--color-basalt-muted-foreground)",
	required: chartColor(1),
	changes: "var(--color-basalt-warning)",
	approved: "var(--color-basalt-primary)",
	none: "var(--color-basalt-border)",
};

export function PullsPage() {
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<PullSort>("updated");
	const [picked, setPicked] = useState<PullFilters>(NO_FILTERS);
	const [history, setHistory] = useState<ReturnType<typeof mergedHistory> | null>(null);
	const pick = (key: keyof PullFilters) => (value: string) =>
		setPicked((old) => ({ ...old, [key]: value }));
	const [snap, setSnap] = useState<PullsSnapshot | { missing: true } | null>(null);

	useEffect(() => {
		// Merged throughput comes from the saved factory snapshot; it gives context when nothing is open.
		void loadFactory()
			.then((f) => setHistory("missing" in f ? null : mergedHistory(f.repos, f.window.until, 30)))
			.catch(() => setHistory(null));
		void loadPulls()
			.then(setSnap)
			.catch((err: unknown) => {
				const missing = catchLoad(err, (message) => {
					toast.error(message);
				});
				if (missing) {
					setSnap(missing);
				}
			});
	}, []);

	const board = useMemo(
		() =>
			snap && !("missing" in snap) ? pullsBoard(snap.pull_requests, snap.fetched_at, picked) : null,
		[snap, picked],
	);
	const rows = useMemo(
		() => (board ? visiblePulls(board.rows, query, sort) : []),
		[board, query, sort],
	);

	if (snap && "missing" in snap) {
		return (
			<div className="space-y-8">
				<PageHeader title="Pull Requests" description={PAGE_DESCRIPTIONS["/pulls"]} />
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
				<PageHeader title="Pull Requests" description={PAGE_DESCRIPTIONS["/pulls"]} />
				<TableSkeleton label="加载 Pull Requests" columns={8} />
			</div>
		);
	}

	if (!board) return null;
	return (
		<div className="giraffe-page-motion space-y-6">
			<PageHeader
				title="Pull Requests"
				description={
					<SnapshotDescription
						description={PAGE_DESCRIPTIONS["/pulls"]}
						fetchedAt={snap.fetched_at}
					/>
				}
				actions={snap.truncated ? <CandyBadge tone="amber">已截断</CandyBadge> : null}
				filters={
					<FilterBar label="Pull Requests 筛选" className="w-full">
						<SearchField
							value={query}
							onValueChange={setQuery}
							label="搜索 Pull Requests"
							placeholder="搜索仓库或标题"
						/>
						<SegmentControl
							legend="排序"
							className={INLINE_SEGMENT}
							value={sort}
							onValueChange={(value) => setSort(value as PullSort)}
							options={[
								{ value: "updated", label: "最近更新" },
								{ value: "repo", label: "按仓库" },
							]}
						/>
					</FilterBar>
				}
			/>
			<div className="giraffe-stat-inline" data-testid="pr-summary">
				<span>
					<strong>{formatCount(board.rows.length)}</strong>个 open PR ·{" "}
					{formatCount(board.repoCount)} 个仓库
				</span>
				<span>
					年龄中位数 <strong>{board.medianAge === null ? "—" : `${board.medianAge} 天`}</strong>
				</span>
				<span>
					变更 <strong>+{formatCount(board.churn.additions)}</strong>/
					<strong>−{formatCount(board.churn.deletions)}</strong>行
				</span>
				<span>
					<strong>{formatCount(board.stale)}</strong>个超过 30 天
				</span>
			</div>
			{history ? (
				<div className="giraffe-overview">
					<div className="lg:col-span-2">
						<OverviewCard
							title="近 30 天 PR 吞吐"
							hint="来自软件工厂最近保存的数据：每日合并与新开的 PR。open 列表为空时，这里说明 PR 是否在持续流动。"
						>
							<CountBars
								data={history.daily}
								series={[
									{ key: "merged", label: "合并", color: FLOW_COLORS.merged },
									{ key: "opened", label: "新开", color: FLOW_COLORS.opened },
								]}
								label="近 30 天每日合并与新开 PR"
								xFormat={(v) => v.slice(5)}
								className="h-48 w-full"
								stacked={false}
							/>
							<p className="giraffe-stat-inline mt-2">
								<span>
									合并 <strong>{formatCount(history.merged)}</strong>
								</span>
								<span>
									新开 <strong>{formatCount(history.opened)}</strong>
								</span>
								<span>
									未合并关闭 <strong>{formatCount(history.closed)}</strong>
								</span>
								<span>
									创建到合并中位数{" "}
									<strong>
										{history.cycleHours === null
											? "—"
											: history.cycleHours < 1
												? `${Math.round(history.cycleHours * 60)} 分钟`
												: `${history.cycleHours.toFixed(1)} 小时`}
									</strong>
								</span>
							</p>
						</OverviewCard>
					</div>
					<OverviewCard title="合并最多的仓库" hint="近 30 天合并 PR 数，来自软件工厂数据。">
						<Breakdown
							rows={history.repos.rows}
							max={history.repos.max}
							label="近 30 天合并 PR 按仓库"
							active=""
							format={shortRepo}
						/>
					</OverviewCard>
				</div>
			) : null}
			{board.total ? (
				<>
					<div className="giraffe-overview">
						<OverviewCard
							title="审查状态"
							hint="草稿、待审查、需修改、已批准与未标记，点击图例下方的状态筛选。"
						>
							<ShareBar
								label="PR 审查状态"
								legend={false}
								parts={REVIEW_STATES.map((r) => ({
									key: r.key,
									label: r.label,
									value: board.review.find((x) => x.key === r.key)?.value ?? 0,
									color: REVIEW_COLORS[r.key],
								}))}
							/>
							<div className="mt-4">
								<Breakdown
									rows={board.review.map((r) => ({
										name: r.key,
										value: r.value,
										color: REVIEW_COLORS[r.key],
									}))}
									max={Math.max(1, ...board.review.map((r) => r.value))}
									label="PR 按审查状态"
									active={picked.review}
									onSelect={pick("review")}
									format={(k) => REVIEW_STATES.find((r) => r.key === k)?.label ?? k}
								/>
							</div>
						</OverviewCard>
						<OverviewCard
							title="年龄与规模"
							hint="上方为创建至今的天数分布，点击筛选；下方为增删行数的规模分组。"
						>
							<AgeStrip
								age={board.age}
								active={picked.age}
								onSelect={pick("age")}
								label="PR 年龄分布"
							/>
							<div className="mt-4">
								<ShareBar
									label="PR 变更规模"
									parts={board.sizes.map((b, i) => ({
										key: b.key,
										label: PR_SIZES[i]?.label ?? b.key,
										value: b.value,
										color: `color-mix(in srgb,var(--color-basalt-primary) ${100 - i * 22}%,var(--color-basalt-border))`,
									}))}
								/>
							</div>
						</OverviewCard>
						<OverviewCard title="按仓库与作者" hint="open PR 最多的仓库与作者，点击筛选。">
							<Breakdown
								rows={board.repos.rows}
								max={board.repos.max}
								label="PR 按仓库"
								active={picked.repo}
								onSelect={pick("repo")}
								format={shortRepo}
							/>
							<div className="mt-3 border-t border-basalt-border pt-3">
								<Breakdown
									rows={board.authors.rows}
									max={board.authors.max}
									label="PR 按作者"
									active={picked.author}
									onSelect={pick("author")}
								/>
							</div>
						</OverviewCard>
					</div>
					<ActiveFilters
						filters={picked}
						labels={FILTER_LABELS}
						format={{
							age: (k) => AGE_BUCKETS.find((b) => b.key === k)?.label ?? k,
							repo: shortRepo,
							review: (k) => REVIEW_STATES.find((r) => r.key === k)?.label ?? k,
						}}
						onClear={(key) => setPicked((old) => (key ? { ...old, [key]: "" } : NO_FILTERS))}
					/>
				</>
			) : null}
			<SectionRule
				title="Pull Requests"
				actions={<ResultCount count={rows.length} total={snap.pull_requests.length} />}
			>
				<LayerCard>
					<LayerCard.Well {...(rows.length === 0 ? {} : { className: "p-0" })}>
						{rows.length === 0 ? (
							<LayerCard.Empty
								icon={<GitPullRequest />}
								title={query.trim() ? "没有匹配结果" : "没有打开的 Pull Request"}
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
						) : (
							<TableScroll label="Pull Request 列表">
								<Table className="min-w-[760px] [&_th]:whitespace-nowrap" data-testid="pr-list">
									<TableHeader>
										<TableRow>
											<TableHead>
												<SortButton
													label="PR / 仓库"
													active={sort === "repo"}
													direction="asc"
													onClick={() => setSort("repo")}
												/>
											</TableHead>
											<TableHead>作者</TableHead>
											<TableHead>状态</TableHead>
											<TableHead className={NUM_HEAD}>变更</TableHead>
											<TableHead className={NUM_HEAD}>
												<SortButton
													label="更新"
													active={sort === "updated"}
													onClick={() => setSort("updated")}
												/>
											</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{rows.map((row) => {
											const churn = churnFilled(row.additions, row.deletions);
											return (
												<TableRow key={`${row.name_with_owner}#${row.number}`}>
													<TableCell className="w-[42%] min-w-64">
														<Link
															href={row.url}
															target="_blank"
															rel="noreferrer"
															className="font-medium text-basalt-foreground [overflow-wrap:anywhere] hover:text-basalt-primary"
														>
															{row.title}
														</Link>
														<div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-basalt-muted-foreground">
															<span className="tabular-nums">#{row.number}</span>
															<span aria-hidden="true">·</span>
															<Link
																href={`/repos/${row.name_with_owner}`}
																className="text-basalt-muted-foreground"
															>
																{row.name_with_owner}
															</Link>
														</div>
													</TableCell>
													<TableCell>
														<PersonCell login={row.author_login} />
													</TableCell>
													<TableCell>
														<div className="flex flex-wrap gap-1">
															{row.is_draft ? <CandyBadge tone="purple">草稿</CandyBadge> : null}
															{row.review_decision ? (
																<CandyBadge tone={reviewBadgeVariant(row.review_decision)}>
																	{formatReview(row.review_decision)}
																</CandyBadge>
															) : null}
															{!row.is_draft && !row.review_decision ? (
																<span className="text-basalt-muted-foreground">—</span>
															) : null}
														</div>
													</TableCell>
													<TableCell>
														<div className="flex items-center justify-end gap-2">
															<ChurnMeter
																adds={churn.adds}
																dels={churn.dels}
																label={`${row.name_with_owner}#${row.number} diff`}
															/>
															<span className={NUM_CELL}>
																<span className="text-basalt-primary">
																	+{formatCount(row.additions)}
																</span>
																<span className="text-basalt-muted-foreground">/</span>
																<span className="text-basalt-danger">
																	−{formatCount(row.deletions)}
																</span>
															</span>
														</div>
													</TableCell>
													<TableCell className={DATE_CELL}>{formatDate(row.updated_at)}</TableCell>
												</TableRow>
											);
										})}
									</TableBody>
								</Table>
							</TableScroll>
						)}
					</LayerCard.Well>
				</LayerCard>
			</SectionRule>
		</div>
	);
}
