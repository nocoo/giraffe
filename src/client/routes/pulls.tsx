import { Badge, Input, Link, toast } from "@nocoo/basalt";
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
import { Kpi, KpiRow } from "../components/layout/kpi";
import { TableSkeleton } from "../components/layout/page-skeleton";
import { RefreshButton } from "../components/layout/refresh-button";
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
							description="先添加 PAT 或刷新。"
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
				description={PAGE_DESCRIPTIONS["/pulls"]}
				actions={
					<>
						{snap.truncated ? <Badge variant="warning">已截断</Badge> : null}
						<RefreshButton
							run={() => requestRefresh(["prs"]).then(() => loadPulls().then(setSnap))}
							onError={onLoadError}
						/>
					</>
				}
				filters={
					<Input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="搜索仓库或标题"
						aria-label="搜索 Pull Requests"
						size="sm"
						className="w-56 shrink-0"
					/>
				}
			/>
			<KpiRow>
				<Kpi icon={GitPullRequest} label="草稿" value={formatCount(metrics.draft)} />
				<Kpi icon={Eye} label="待审查" value={formatCount(metrics.reviewRequired)} />
				<Kpi icon={ShieldAlert} label="需修改" value={formatCount(metrics.changesRequested)} />
				<Kpi icon={HeartPulse} label="已批准" value={formatCount(metrics.approved)} />
			</KpiRow>
			<SectionRule title="Pull Requests">
				<LayerCard>
					<LayerCard.Well {...(rows.length === 0 ? {} : { className: "p-0" })}>
						{rows.length === 0 ? (
							<LayerCard.Empty icon={<GitPullRequest />} title="没有 Pull Request" />
						) : (
							<Table data-testid="pr-list">
								<TableHeader>
									<TableRow>
										<TableHead>
											<SortButton
												label="仓库"
												active={sort === "repo"}
												onClick={() => setSort("repo")}
											/>
										</TableHead>
										<TableHead className={NUM_HEAD}>编号</TableHead>
										<TableHead>标题</TableHead>
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
												<TableCell className="text-basalt-muted-foreground">
													{row.name_with_owner}
												</TableCell>
												<TableCell className={NUM_CELL}>#{row.number}</TableCell>
												<TableCell>
													<Link href={row.url} target="_blank" rel="noreferrer">
														{row.title}
													</Link>
												</TableCell>
												<TableCell>
													<PersonCell login={row.author_login} />
												</TableCell>
												<TableCell>
													<div className="flex flex-wrap gap-1">
														{row.is_draft ? <Badge variant="purple">草稿</Badge> : null}
														{row.review_decision ? (
															<Badge variant={reviewBadgeVariant(row.review_decision)}>
																{formatReview(row.review_decision)}
															</Badge>
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
						)}
					</LayerCard.Well>
				</LayerCard>
			</SectionRule>
		</div>
	);
}
