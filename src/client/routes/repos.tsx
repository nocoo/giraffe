import { Badge, Button, Input, Link, SegmentControl, toast } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@nocoo/basalt/components/table";
import { Box } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { LanguageLabel } from "../components/layout/labels";
import { TableSkeleton } from "../components/layout/page-skeleton";
import { RefreshButton } from "../components/layout/refresh-button";
import { INLINE_SEGMENT } from "../components/layout/segment";
import { catchLoad, missingTitle } from "../lib/error-ui";
import {
	DATE_CELL,
	formatCount,
	formatDate,
	formatHealth,
	formatVisibility,
	healthBadgeVariant,
	NUM_CELL,
	NUM_HEAD,
} from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import { requestRefresh } from "../viewmodels/refresh";
import {
	alertsIncomplete,
	healthMap,
	type InsightsSnapshot,
	loadInsightsOptional,
	loadRepos,
	type ReposSnapshot,
	type SortKey,
	type ViewMode,
	visibleRepos,
} from "../viewmodels/repos";

export function ReposPage() {
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<SortKey>("stars");
	const [view, setView] = useState<ViewMode>("list");
	const [snap, setSnap] = useState<ReposSnapshot | { missing: true } | null>(null);
	const [insights, setInsights] = useState<InsightsSnapshot | null>(null);

	function onLoadError(err: unknown): void {
		const missing = catchLoad(err, (message) => {
			toast.error(message);
		});
		if (missing) {
			setSnap(missing);
			setInsights(null);
		}
	}

	async function reload() {
		const next = await loadRepos();
		setSnap(next);
		if (!("missing" in next)) {
			setInsights(await loadInsightsOptional());
		} else {
			setInsights(null);
		}
	}

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
	const actions = (
		<>
			{snap && !("missing" in snap) && snap.truncated ? (
				<Badge variant="warning">已截断</Badge>
			) : null}
			{incomplete ? <Badge variant="warning">告警不完整</Badge> : null}
		</>
	);

	const filters = (
		<>
			<Input
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				placeholder="搜索仓库"
				aria-label="搜索仓库"
				className="w-56 shrink-0"
			/>
			<SegmentControl
				legend="排序"
				className={INLINE_SEGMENT}
				value={sort}
				onValueChange={(value) => setSort(value as SortKey)}
				options={[
					{ value: "stars", label: "Star" },
					{ value: "pushed", label: "最近推送" },
					{ value: "name", label: "名称" },
				]}
			/>
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
	);

	if (snap && "missing" in snap) {
		return (
			<div className="space-y-8">
				<PageHeader
					title="仓库"
					description={PAGE_DESCRIPTIONS["/"]}
					actions={
						<RefreshButton
							run={() => requestRefresh(["repos"]).then(() => reload())}
							onError={onLoadError}
						/>
					}
				/>
				<LayerCard>
					<LayerCard.Well>
						<LayerCard.Empty
							icon={<Box />}
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
				<PageHeader title="仓库" description={PAGE_DESCRIPTIONS["/"]} />
				<TableSkeleton label="加载仓库" columns={8} />
			</div>
		);
	}

	return (
		<div className="space-y-8">
			<PageHeader
				title="仓库"
				description={PAGE_DESCRIPTIONS["/"]}
				actions={
					<>
						{actions}
						<RefreshButton
							run={() => requestRefresh(["repos"]).then(() => reload())}
							onError={onLoadError}
						/>
					</>
				}
				filters={filters}
			/>
			{rows.length === 0 ? (
				<LayerCard>
					<LayerCard.Well>
						<LayerCard.Empty icon={<Box />} title="没有仓库" />
					</LayerCard.Well>
				</LayerCard>
			) : view === "grid" ? (
				<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="repo-list">
					{rows.map((row) => {
						const status = health.get(row.name_with_owner);
						return (
							<Link
								key={row.name_with_owner}
								href={`/repos/${row.owner_login}/${row.name}`}
								className="text-basalt-foreground no-underline hover:no-underline"
							>
								<LayerCard padding="md" className="h-full">
									<div className="flex items-start justify-between gap-2">
										<p className="truncate font-medium">{row.name_with_owner}</p>
										{status ? (
											<Badge variant={healthBadgeVariant(status)}>{formatHealth(status)}</Badge>
										) : null}
									</div>
									<p className="mt-2 line-clamp-2 text-sm text-basalt-muted-foreground">
										{row.description ?? "没有描述"}
									</p>
									<div className="mt-3 flex items-center gap-2 text-xs text-basalt-muted-foreground">
										<LanguageLabel name={row.primary_language} />
										<span>·</span>
										<span className="tabular-nums">★ {formatCount(row.stargazer_count)}</span>
										<span>·</span>
										<Badge variant="outline">{formatVisibility(row.visibility)}</Badge>
									</div>
								</LayerCard>
							</Link>
						);
					})}
				</div>
			) : (
				<LayerCard>
					<LayerCard.Well className="p-0">
						<Table data-testid="repo-list">
							<TableHeader>
								<TableRow>
									<TableHead>
										<Button type="button" variant="ghost" onClick={() => setSort("name")}>
											仓库
										</Button>
									</TableHead>
									<TableHead>语言</TableHead>
									<TableHead className={NUM_HEAD}>
										<Button type="button" variant="ghost" onClick={() => setSort("stars")}>
											★
										</Button>
									</TableHead>
									<TableHead className={NUM_HEAD}>Fork</TableHead>
									<TableHead className={NUM_HEAD}>Issues</TableHead>
									<TableHead className={NUM_HEAD}>
										<Button type="button" variant="ghost" onClick={() => setSort("pushed")}>
											最近推送
										</Button>
									</TableHead>
									<TableHead>可见性</TableHead>
									{health.size > 0 ? <TableHead>健康</TableHead> : null}
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((row) => {
									const status = health.get(row.name_with_owner);
									return (
										<TableRow key={row.name_with_owner}>
											<TableCell>
												<Link href={`/repos/${row.owner_login}/${row.name}`}>
													{row.name_with_owner}
												</Link>
											</TableCell>
											<TableCell>
												<LanguageLabel name={row.primary_language} />
											</TableCell>
											<TableCell className={NUM_CELL}>{formatCount(row.stargazer_count)}</TableCell>
											<TableCell className={NUM_CELL}>{formatCount(row.fork_count)}</TableCell>
											<TableCell className={NUM_CELL}>
												{formatCount(row.open_issue_count)}
											</TableCell>
											<TableCell className={DATE_CELL}>{formatDate(row.pushed_at)}</TableCell>
											<TableCell>
												<Badge variant="outline">{formatVisibility(row.visibility)}</Badge>
											</TableCell>
											{health.size > 0 ? (
												<TableCell>
													{status ? (
														<Badge variant={healthBadgeVariant(status)}>
															{formatHealth(status)}
														</Badge>
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
					</LayerCard.Well>
				</LayerCard>
			)}
		</div>
	);
}
