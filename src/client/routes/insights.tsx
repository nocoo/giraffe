import { Badge, SegmentControl, Toolbar, toast } from "@nocoo/basalt";
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
import { RefreshButton } from "../components/layout/refresh-button";
import { catchLoad } from "../lib/error-ui";
import {
	alertsIncomplete,
	filterInsights,
	type Health,
	type InsightsSnapshot,
	loadInsights,
} from "../viewmodels/insights";
import { requestRefresh } from "../viewmodels/refresh";

export function InsightsPage() {
	const [health, setHealth] = useState<Health | "all">("all");
	const [snap, setSnap] = useState<InsightsSnapshot | { missing: true } | null>(null);

	function onLoadError(err: unknown): void {
		const missing = catchLoad(err, toast);
		if (missing) {
			setSnap(missing);
		}
	}

	useEffect(() => {
		void loadInsights()
			.then(setSnap)
			.catch((err: unknown) => {
				const missing = catchLoad(err, toast);
				if (missing) {
					setSnap(missing);
				}
			});
	}, []);

	const rows = useMemo(() => {
		if (!snap || "missing" in snap) {
			return [];
		}
		return filterInsights(snap.insights, health);
	}, [snap, health]);
	const incomplete = snap && !("missing" in snap) ? alertsIncomplete(snap) : false;

	if (snap && "missing" in snap) {
		return (
			<div className="flex flex-col gap-4">
				<PageHeader title="Insights" />
				<Empty title="没有快照" description="先添加 PAT 或刷新。" />
				<RefreshButton
					variant="default"
					run={() =>
						requestRefresh(["repos", "issues", "alerts"]).then(() => loadInsights().then(setSnap))
					}
					onError={onLoadError}
				/>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<PageHeader title="Insights" />
			{snap?.truncated ? <Badge>已截断</Badge> : null}
			{incomplete ? <Badge>告警不完整</Badge> : null}
			<Toolbar aria-label="Insights 工具条">
				<SegmentControl
					legend="健康"
					value={health}
					onValueChange={(value) => setHealth(value as Health | "all")}
					options={[
						{ value: "all", label: "全部" },
						{ value: "strong", label: "strong" },
						{ value: "watch", label: "watch" },
						{ value: "risky", label: "risky" },
					]}
				/>
				<RefreshButton
					run={() =>
						requestRefresh(["repos", "issues", "alerts"]).then(() => loadInsights().then(setSnap))
					}
					onError={onLoadError}
				/>
			</Toolbar>
			{rows.length === 0 ? (
				<Empty title="没有 Insights" />
			) : (
				<Table data-testid="insight-list">
					<TableHeader>
						<TableRow>
							<TableHead>仓</TableHead>
							<TableHead>health</TableHead>
							<TableHead>issues</TableHead>
							<TableHead>距上次 push</TableHead>
							<TableHead>opportunities</TableHead>
							<TableHead>alerts</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row) => (
							<TableRow key={row.name_with_owner}>
								<TableCell>{row.name_with_owner}</TableCell>
								<TableCell>
									<Badge>{row.health}</Badge>
								</TableCell>
								<TableCell>{row.open_issue_count}</TableCell>
								<TableCell>{row.days_since_push}</TableCell>
								<TableCell>
									{row.opportunities.length === 0 ? (
										"—"
									) : (
										<ul>
											{row.opportunities.map((item) => (
												<li key={item}>{item}</li>
											))}
										</ul>
									)}
								</TableCell>
								<TableCell>
									{row.alerts.length === 0 ? (
										"—"
									) : (
										<ul>
											{row.alerts.map((alert) => (
												<li key={alert.url}>{alert.summary}</li>
											))}
										</ul>
									)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</div>
	);
}
