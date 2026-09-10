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
import { Box, CircleDot } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CandyBadge } from "../components/layout/candy-badge";
import {
	ResultCount,
	SearchField,
	SnapshotDescription,
	TableScroll,
} from "../components/layout/collection-chrome";
import { Kpi, KpiRow } from "../components/layout/kpi";
import { TableSkeleton } from "../components/layout/page-skeleton";
import { RefreshButton } from "../components/layout/refresh-button";
import { INLINE_SEGMENT } from "../components/layout/segment";
import { LabelChips, PersonCell, SortButton } from "../components/layout/table-chrome";
import { catchLoad, missingTitle } from "../lib/error-ui";
import { DATE_CELL, formatCount, formatDate, NUM_CELL, NUM_HEAD } from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import {
	type IssueSort,
	type IssuesSnapshot,
	issueMetrics,
	loadIssues,
	visibleIssues,
} from "../viewmodels/issues";
import { requestRefresh } from "../viewmodels/refresh";

export function IssuesPage() {
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<IssueSort>("updated");
	const [snap, setSnap] = useState<IssuesSnapshot | { missing: true } | null>(null);

	function onLoadError(err: unknown): void {
		const missing = catchLoad(err, (message) => {
			toast.error(message);
		});
		if (missing) {
			setSnap(missing);
		}
	}

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

	const rows = useMemo(() => {
		if (!snap || "missing" in snap) {
			return [];
		}
		return visibleIssues(snap.issues, query, sort);
	}, [snap, query, sort]);

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
				<PageHeader
					title="Issues"
					description={PAGE_DESCRIPTIONS["/issues"]}
					actions={
						<RefreshButton
							run={() => requestRefresh(["issues"]).then(() => loadIssues().then(setSnap))}
							onError={onLoadError}
						/>
					}
				/>
				<LayerCard>
					<LayerCard.Well>
						<LayerCard.Empty
							icon={<CircleDot />}
							title={missingTitle(snap)}
							description="点击刷新获取数据，或前往设置检查 GitHub 账号连接。"
							action={
								<Button variant="secondary" size="sm" asChild>
									<Link href="/settings">查看账号设置</Link>
								</Button>
							}
						/>
					</LayerCard.Well>
				</LayerCard>
			</div>
		);
	}

	if (!snap) {
		return (
			<div className="space-y-8">
				<PageHeader title="Issues" description={PAGE_DESCRIPTIONS["/issues"]} />
				<TableSkeleton label="加载 Issues" columns={5} />
			</div>
		);
	}

	const metrics = issueMetrics(snap.issues);

	return (
		<div className="space-y-8">
			<PageHeader
				title="Issues"
				description={
					<SnapshotDescription
						description={PAGE_DESCRIPTIONS["/issues"]}
						fetchedAt={snap.fetched_at}
					/>
				}
				actions={
					<>
						{snap.truncated ? <CandyBadge tone="amber">已截断</CandyBadge> : null}
						<RefreshButton
							run={() => requestRefresh(["issues"]).then(() => loadIssues().then(setSnap))}
							onError={onLoadError}
						/>
					</>
				}
				filters={filters}
			/>
			<KpiRow>
				<Kpi icon={CircleDot} label="打开 Issues" value={formatCount(metrics.count)} />
				<Kpi icon={Box} label="涉及仓库" value={formatCount(metrics.repos)} />
			</KpiRow>
			<SectionRule
				title="Issues"
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
										: "当前快照中没有相关内容，刷新可获取最新数据。"
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
								<Table className="min-w-[760px] [&_th]:whitespace-nowrap" data-testid="issue-list">
									<TableHeader>
										<TableRow>
											<TableHead>
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
