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
import { Box, CircleDot } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Kpi, KpiRow } from "../components/layout/kpi";
import { TableSkeleton } from "../components/layout/page-skeleton";
import { RefreshButton } from "../components/layout/refresh-button";
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
		<Input
			value={query}
			onChange={(event) => setQuery(event.target.value)}
			placeholder="搜索仓库或标题"
			aria-label="搜索 Issues"
			size="sm"
			className="w-56 shrink-0"
		/>
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
				description={PAGE_DESCRIPTIONS["/issues"]}
				actions={
					<>
						{snap.truncated ? <Badge variant="warning">已截断</Badge> : null}
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
			<SectionRule title="Issues">
				<LayerCard>
					<LayerCard.Well {...(rows.length === 0 ? {} : { className: "p-0" })}>
						{rows.length === 0 ? (
							<LayerCard.Empty icon={<CircleDot />} title="没有 Issue" />
						) : (
							<Table data-testid="issue-list">
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
												<LabelChips labels={row.labels} />
											</TableCell>
											<TableCell>
												<PersonCell login={row.author_login} />
											</TableCell>
											<TableCell className={NUM_CELL}>{formatCount(row.comments_count)}</TableCell>
											<TableCell className={DATE_CELL}>{formatDate(row.updated_at)}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
					</LayerCard.Well>
				</LayerCard>
			</SectionRule>
		</div>
	);
}
