import { Badge, Button, Input, LayerCard, Link, SegmentControl, toast } from "@nocoo/basalt";
import { Empty } from "@nocoo/basalt/components/empty";
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
import { RefreshButton } from "../components/layout/refresh-button";
import { catchLoad, missingTitle } from "../lib/error-ui";
import {
	formatCount,
	formatDate,
	formatHealth,
	formatVisibility,
	healthBadgeVariant,
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
		const missing = catchLoad(err, toast);
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
				const missing = catchLoad(err, toast);
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

	if (snap && "missing" in snap) {
		return (
			<div className="flex flex-col gap-6">
				<PageHeader title="仓库" description={PAGE_DESCRIPTIONS["/"]} />
				<Empty icon={<Box />} title={missingTitle(snap)} description="先添加 PAT 或刷新。" />
				<RefreshButton
					variant="default"
					run={() => requestRefresh(["repos"]).then(() => reload())}
					onError={onLoadError}
				/>
			</div>
		);
	}

	if (!snap) {
		return (
			<div className="flex flex-col gap-6">
				<PageHeader title="仓库" description={PAGE_DESCRIPTIONS["/"]} />
				<LayerCard.Loading label="加载仓库" />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-6">
			<PageHeader title="仓库" description={PAGE_DESCRIPTIONS["/"]} actions={actions} />
			<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
				<Input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="搜索仓库"
					aria-label="搜索仓库"
					className="md:max-w-sm"
				/>
				<div className="flex flex-wrap items-center gap-2">
					<SegmentControl
						legend="排序"
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
						value={view}
						onValueChange={(value) => setView(value as ViewMode)}
						options={[
							{ value: "list", label: "列表" },
							{ value: "grid", label: "网格" },
						]}
					/>
					<RefreshButton
						run={() => requestRefresh(["repos"]).then(() => reload())}
						onError={onLoadError}
					/>
				</div>
			</div>
			{rows.length === 0 ? (
				<Empty icon={<Box />} title="没有仓库" />
			) : view === "grid" ? (
				<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="repo-list">
					{rows.map((row) => {
						const status = health.get(row.name_with_owner);
						return (
							<Link
								key={row.name_with_owner}
								href={`/repos/${row.owner_login}/${row.name}`}
								className="text-basalt-foreground no-underline hover:no-underline"
							>
								<LayerCard className="h-full transition-colors hover:bg-basalt-accent/30">
									<LayerCard.Header>
										<p className="truncate font-medium">{row.name_with_owner}</p>
										{status ? (
											<Badge variant={healthBadgeVariant(status)}>{formatHealth(status)}</Badge>
										) : null}
									</LayerCard.Header>
									<LayerCard.Body>
										<p className="line-clamp-2 text-sm text-basalt-muted-foreground">
											{row.description ?? "没有描述"}
										</p>
										<p className="mt-3 text-xs text-basalt-muted-foreground">
											{row.primary_language ?? "—"} · ★ {formatCount(row.stargazer_count)} ·{" "}
											{formatVisibility(row.visibility)}
										</p>
									</LayerCard.Body>
								</LayerCard>
							</Link>
						);
					})}
				</div>
			) : (
				<Table data-testid="repo-list">
					<TableHeader>
						<TableRow>
							<TableHead>
								<Button type="button" variant="ghost" onClick={() => setSort("name")}>
									仓库
								</Button>
							</TableHead>
							<TableHead>语言</TableHead>
							<TableHead>
								<Button type="button" variant="ghost" onClick={() => setSort("stars")}>
									★
								</Button>
							</TableHead>
							<TableHead>Fork</TableHead>
							<TableHead>Issues</TableHead>
							<TableHead>
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
									<TableCell className="text-basalt-muted-foreground">
										{row.primary_language ?? "—"}
									</TableCell>
									<TableCell className="tabular-nums">{formatCount(row.stargazer_count)}</TableCell>
									<TableCell className="tabular-nums">{formatCount(row.fork_count)}</TableCell>
									<TableCell className="tabular-nums">
										{formatCount(row.open_issue_count)}
									</TableCell>
									<TableCell className="text-basalt-muted-foreground">
										{formatDate(row.pushed_at)}
									</TableCell>
									<TableCell>{formatVisibility(row.visibility)}</TableCell>
									{health.size > 0 ? (
										<TableCell>
											{status ? (
												<Badge variant={healthBadgeVariant(status)}>{formatHealth(status)}</Badge>
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
			)}
		</div>
	);
}
