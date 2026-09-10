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
import { Eye, GitPullRequest, HeartPulse, ShieldAlert } from "lucide-react";
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
import { ChurnMeter, PersonCell, SortButton } from "../components/layout/table-chrome";
import { catchLoad, missingTitle } from "../lib/error-ui";
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
	loadPulls,
	type PullSort,
	type PullsSnapshot,
	pullMetrics,
	visiblePulls,
} from "../viewmodels/pulls";
import { requestRefresh } from "../viewmodels/refresh";

export function PullsPage() {
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<PullSort>("updated");
	const [snap, setSnap] = useState<PullsSnapshot | { missing: true } | null>(null);

	function onLoadError(err: unknown): void {
		const missing = catchLoad(err, (message) => {
			toast.error(message);
		});
		if (missing) {
			setSnap(missing);
		}
	}

	useEffect(() => {
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

	const rows = useMemo(() => {
		if (!snap || "missing" in snap) {
			return [];
		}
		return visiblePulls(snap.pull_requests, query, sort);
	}, [snap, query, sort]);

	if (snap && "missing" in snap) {
		return (
			<div className="space-y-8">
				<PageHeader
					title="Pull Requests"
					description={PAGE_DESCRIPTIONS["/pulls"]}
					actions={
						<RefreshButton
							run={() => requestRefresh(["prs"]).then(() => loadPulls().then(setSnap))}
							onError={onLoadError}
						/>
					}
				/>
				<LayerCard>
					<LayerCard.Well>
						<LayerCard.Empty
							icon={<GitPullRequest />}
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
				<PageHeader title="Pull Requests" description={PAGE_DESCRIPTIONS["/pulls"]} />
				<TableSkeleton label="加载 Pull Requests" columns={8} />
			</div>
		);
	}

	const metrics = pullMetrics(snap.pull_requests);

	return (
		<div className="space-y-8">
			<PageHeader
				title="Pull Requests"
				description={
					<SnapshotDescription
						description={PAGE_DESCRIPTIONS["/pulls"]}
						fetchedAt={snap.fetched_at}
					/>
				}
				actions={
					<>
						{snap.truncated ? <CandyBadge tone="amber">已截断</CandyBadge> : null}
						<RefreshButton
							run={() => requestRefresh(["prs"]).then(() => loadPulls().then(setSnap))}
							onError={onLoadError}
						/>
					</>
				}
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
			<KpiRow>
				<Kpi icon={GitPullRequest} label="草稿" value={formatCount(metrics.draft)} />
				<Kpi icon={Eye} label="待审查" value={formatCount(metrics.reviewRequired)} />
				<Kpi icon={ShieldAlert} label="需修改" value={formatCount(metrics.changesRequested)} />
				<Kpi icon={HeartPulse} label="已批准" value={formatCount(metrics.approved)} />
			</KpiRow>
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
																<span className="text-basalt-info">
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
