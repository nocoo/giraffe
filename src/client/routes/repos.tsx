import { Badge, Button, Input, LayerCard, SegmentControl } from "@nocoo/basalt";
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
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
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
		void loadRepos().then(async (next) => {
			setSnap(next);
			if (!("missing" in next)) {
				setInsights(await loadInsightsOptional());
			} else {
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

	if (snap && "missing" in snap) {
		return (
			<div className="flex flex-col gap-4">
				<PageHeader title="仓库" />
				<Empty title="没有快照" description="先添加 PAT 或刷新。" />
				<Button
					type="button"
					onClick={() => {
						void requestRefresh(["repos"]).then(() => reload());
					}}
				>
					刷新
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<PageHeader title="仓库" />
			{snap?.truncated ? <Badge>已截断</Badge> : null}
			{incomplete ? <Badge>告警不完整</Badge> : null}
			<div className="flex flex-wrap items-center gap-3">
				<Input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="搜索仓库"
					aria-label="搜索仓库"
				/>
				<SegmentControl
					legend="排序"
					value={sort}
					onValueChange={(value) => setSort(value as SortKey)}
					options={[
						{ value: "stars", label: "Star" },
						{ value: "pushed", label: "最近 push" },
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
			</div>
			{rows.length === 0 ? (
				<Empty title="没有仓库" />
			) : view === "grid" ? (
				<div className="grid gap-3 md:grid-cols-2" data-testid="repo-list">
					{rows.map((row) => (
						<Link key={row.name_with_owner} to={`/repos/${row.owner_login}/${row.name}`}>
							<LayerCard>
								<p className="font-medium">{row.name_with_owner}</p>
								<p className="text-sm text-basalt-muted-foreground">{row.description ?? "—"}</p>
							</LayerCard>
						</Link>
					))}
				</div>
			) : (
				<Table data-testid="repo-list">
					<TableHeader>
						<TableRow>
							<TableHead>
								<button type="button" onClick={() => setSort("name")}>
									仓库
								</button>
							</TableHead>
							<TableHead>语言</TableHead>
							<TableHead>
								<button type="button" onClick={() => setSort("stars")}>
									★
								</button>
							</TableHead>
							<TableHead>fork</TableHead>
							<TableHead>issues</TableHead>
							<TableHead>
								<button type="button" onClick={() => setSort("pushed")}>
									最近 push
								</button>
							</TableHead>
							<TableHead>可见性</TableHead>
							{health.size > 0 ? <TableHead>健康</TableHead> : null}
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row) => (
							<TableRow key={row.name_with_owner}>
								<TableCell>
									<Link to={`/repos/${row.owner_login}/${row.name}`}>{row.name_with_owner}</Link>
								</TableCell>
								<TableCell>{row.primary_language ?? "—"}</TableCell>
								<TableCell>{row.stargazer_count}</TableCell>
								<TableCell>{row.fork_count}</TableCell>
								<TableCell>{row.open_issue_count}</TableCell>
								<TableCell>{row.pushed_at ?? "—"}</TableCell>
								<TableCell>{row.visibility}</TableCell>
								{health.size > 0 ? (
									<TableCell>{health.get(row.name_with_owner) ?? "—"}</TableCell>
								) : null}
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</div>
	);
}
