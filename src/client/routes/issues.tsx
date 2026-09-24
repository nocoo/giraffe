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
import { CircleDot } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CandyBadge } from "../components/layout/candy-badge";
import {
	ResultCount,
	SearchField,
	SnapshotDescription,
	TableScroll,
} from "../components/layout/collection-chrome";
import { IconLabel } from "../components/layout/icon-label";
import {
	ActiveFilters,
	AgeStrip,
	Breakdown,
	CountBars,
	OverviewCard,
} from "../components/layout/overview-cards";
import { ListPageSkeleton } from "../components/layout/page-skeleton";
import { ProjectLink } from "../components/layout/project-identity";
import { INLINE_SEGMENT } from "../components/layout/segment";
import { SnapshotPending } from "../components/layout/snapshot-pending";
import { LabelChips, PersonCell, SortButton } from "../components/layout/table-chrome";
import { FLOW_COLORS } from "../lib/chart-theme";
import { catchLoad } from "../lib/error-ui";
import { DATE_CELL, formatCount, formatDate, NUM_CELL, NUM_HEAD } from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import { type WorkFilters, workBoard } from "../viewmodels/boards";
import {
	type IssueSort,
	type IssuesSnapshot,
	loadIssues,
	visibleIssues,
} from "../viewmodels/issues";
import { AGE_BUCKETS, shortRepo } from "../viewmodels/overview";

const NO_FILTERS: WorkFilters = { repo: "", label: "", author: "", age: "" };
const FILTER_LABELS = { repo: "仓库", label: "标签", author: "作者", age: "年龄" };
const AGE_LABEL = (key: string) => AGE_BUCKETS.find((b) => b.key === key)?.label ?? key;

export function IssuesPage() {
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<IssueSort>("updated");
	const [picked, setPicked] = useState<WorkFilters>(NO_FILTERS);
	const pick = (key: keyof WorkFilters) => (value: string) =>
		setPicked((old) => ({ ...old, [key]: value }));
	const [snap, setSnap] = useState<IssuesSnapshot | { missing: true } | null>(null);

	useEffect(() => {
		void loadIssues()
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
		() => (snap && !("missing" in snap) ? workBoard(snap.issues, snap.fetched_at, picked) : null),
		[snap, picked],
	);
	const rows = useMemo(
		() => (board ? visibleIssues(board.rows, query, sort) : []),
		[board, query, sort],
	);

	const filters = (
		<FilterBar label="Issues 筛选" className="w-full">
			<SearchField
				value={query}
				onValueChange={setQuery}
				label="搜索 Issues"
				placeholder="搜索仓库或标题"
			/>
			<SegmentControl
				legend="排序"
				className={INLINE_SEGMENT}
				value={sort}
				onValueChange={(value) => setSort(value as IssueSort)}
				options={[
					{ value: "updated", label: "最近更新" },
					{ value: "repo", label: "按仓库" },
				]}
			/>
		</FilterBar>
	);

	if (snap && "missing" in snap) {
		return (
			<div className="space-y-8">
				<PageHeader title="Issues" description={PAGE_DESCRIPTIONS["/issues"]} />
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
				<PageHeader title="Issues" description={PAGE_DESCRIPTIONS["/issues"]} />
				<ListPageSkeleton label="加载 Issues" cards={["columns", "rank", "bars"]} columns={5} />
			</div>
		);
	}

	if (!board) return null;
	return (
		<div className="giraffe-page-motion space-y-6">
			<PageHeader
				title="Issues"
				description={
					<SnapshotDescription
						description={PAGE_DESCRIPTIONS["/issues"]}
						fetchedAt={snap.fetched_at}
					/>
				}
				actions={snap.truncated ? <CandyBadge tone="amber">已截断</CandyBadge> : null}
				filters={filters}
			/>
			<div className="giraffe-stat-inline" data-testid="issue-summary">
				<span>
					<strong>{formatCount(board.rows.length)}</strong>
					{board.rows.length === board.total
						? "个 open Issue"
						: `/ ${formatCount(board.total)} 个 open Issue`}
				</span>
				<span>
					<strong>{formatCount(board.repoCount)}</strong>
					个仓库
				</span>
				<span>
					年龄中位数 <strong>{board.medianAge === null ? "—" : `${board.medianAge} 天`}</strong>
				</span>
				<span>
					<strong>{formatCount(board.stale)}</strong>个超过 30 天
				</span>
				<span>
					<strong>{formatCount(board.discussed)}</strong>个有评论
				</span>
			</div>
			<div className="giraffe-overview">
				<OverviewCard
					title="积压年龄"
					hint="按创建时间分组，点击任一列筛选下方列表。越靠右越久未关闭。"
				>
					<AgeStrip
						age={board.age}
						active={picked.age}
						onSelect={pick("age")}
						label="Issue 年龄分布"
					/>
				</OverviewCard>
				<OverviewCard
					title="按仓库"
					hint="当前筛选下 open Issue 最多的仓库，其余合并为「其他」。点击筛选。"
				>
					<Breakdown
						rows={board.repos.rows}
						max={board.repos.max}
						label="Issue 按仓库"
						active={picked.repo}
						onSelect={pick("repo")}
						format={shortRepo}
					/>
				</OverviewCard>
				<OverviewCard
					title="新增节奏与标签"
					hint="柱为近 12 周每周新建、目前仍 open 的 Issue；下方为标签分布，点击筛选。"
				>
					<CountBars
						data={board.weekly}
						series={[{ key: "y", label: "新建且仍 open", color: "var(--color-basalt-chart-5)" }]}
						label="近 12 周新建 Issue"
						className="h-28 w-full"
					/>
					<div className="mt-3">
						<Breakdown
							rows={board.labels.rows}
							max={board.labels.max}
							label="Issue 按标签"
							active={picked.label}
							onSelect={pick("label")}
							color={FLOW_COLORS.opened}
						/>
					</div>
				</OverviewCard>
			</div>
			<ActiveFilters
				filters={picked}
				labels={FILTER_LABELS}
				format={{ age: AGE_LABEL, repo: shortRepo }}
				onClear={(key) => setPicked((old) => (key ? { ...old, [key]: "" } : NO_FILTERS))}
			/>
			<SectionRule
				title={<IconLabel icon={CircleDot}>Issues</IconLabel>}
				actions={<ResultCount count={rows.length} total={snap.issues.length} />}
			>
				<LayerCard>
					<LayerCard.Well {...(rows.length === 0 ? {} : { className: "p-0" })}>
						{rows.length === 0 ? (
							<LayerCard.Empty
								icon={<CircleDot />}
								title={query.trim() ? "没有匹配结果" : "没有打开的 Issue"}
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
							<TableScroll label="Issue 列表">
								<Table className="giraffe-data-table min-w-[760px]" data-testid="issue-list">
									<TableHeader>
										<TableRow>
											<TableHead data-grow>
												<SortButton
													label="Issue / 仓库"
													active={sort === "repo"}
													direction="asc"
													onClick={() => setSort("repo")}
												/>
											</TableHead>
											<TableHead>标签</TableHead>
											<TableHead>作者</TableHead>
											<TableHead className={NUM_HEAD}>评论</TableHead>
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
										{rows.map((row) => (
											<TableRow key={`${row.name_with_owner}#${row.number}`}>
												<TableCell className="w-[42%] min-w-64">
													<Link
														href={row.url}
														target="_blank"
														rel="noreferrer"
														className="font-medium text-basalt-foreground giraffe-wrap [overflow-wrap:anywhere] hover:text-basalt-primary"
													>
														{row.title}
													</Link>
													<div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-basalt-muted-foreground">
														<span className="tabular-nums">#{row.number}</span>
														<span aria-hidden="true">·</span>
														<ProjectLink
															repo={row.name_with_owner}
															className="text-basalt-muted-foreground"
														/>
													</div>
												</TableCell>
												<TableCell>
													<LabelChips labels={row.labels} />
												</TableCell>
												<TableCell>
													<PersonCell login={row.author_login} />
												</TableCell>
												<TableCell className={NUM_CELL}>
													{formatCount(row.comments_count)}
												</TableCell>
												<TableCell className={DATE_CELL}>{formatDate(row.updated_at)}</TableCell>
											</TableRow>
										))}
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
