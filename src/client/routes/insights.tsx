import { Badge, Link, SegmentControl, toast } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@nocoo/basalt/components/table";
import { Activity } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PageSkeleton } from "../components/layout/page-skeleton";
import { INLINE_SEGMENT, PageToolbar } from "../components/layout/page-toolbar";
import { RefreshButton } from "../components/layout/refresh-button";
import { catchLoad, missingTitle } from "../lib/error-ui";
import { formatHealth, healthBadgeVariant } from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
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
		const missing = catchLoad(err, (message) => {
			toast.error(message);
		});
		if (missing) {
			setSnap(missing);
		}
	}

	useEffect(() => {
		void loadInsights()
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
		return filterInsights(snap.insights, health);
	}, [snap, health]);
	const incomplete = snap && !("missing" in snap) ? alertsIncomplete(snap) : false;

	if (snap && "missing" in snap) {
		return (
			<div className="flex flex-col gap-4">
				<PageToolbar
					title="Insights"
					description={PAGE_DESCRIPTIONS["/insights"]}
					actions={
						<RefreshButton
							variant="default"
							run={() =>
								requestRefresh(["repos", "issues", "alerts"]).then(() =>
									loadInsights().then(setSnap),
								)
							}
							onError={onLoadError}
						/>
					}
				/>
				<LayerCard>
					<LayerCard.Primary>
						<LayerCard.Empty
							icon={<Activity />}
							title={missingTitle(snap)}
							description="先添加 PAT 或刷新。"
						/>
					</LayerCard.Primary>
				</LayerCard>
			</div>
		);
	}

	if (!snap) {
		return (
			<div className="flex flex-col gap-4">
				<PageToolbar title="Insights" description={PAGE_DESCRIPTIONS["/insights"]} />
				<PageSkeleton label="加载 Insights" />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<PageToolbar
				title="Insights"
				description={PAGE_DESCRIPTIONS["/insights"]}
				actions={
					<>
						{snap.truncated ? <Badge variant="warning">已截断</Badge> : null}
						{incomplete ? <Badge variant="warning">告警不完整</Badge> : null}
						<SegmentControl
							legend="健康"
							className={INLINE_SEGMENT}
							value={health}
							onValueChange={(value) => setHealth(value as Health | "all")}
							options={[
								{ value: "all", label: "全部" },
								{ value: "strong", label: "健康" },
								{ value: "watch", label: "观察" },
								{ value: "risky", label: "风险" },
							]}
						/>
						<RefreshButton
							run={() =>
								requestRefresh(["repos", "issues", "alerts"]).then(() =>
									loadInsights().then(setSnap),
								)
							}
							onError={onLoadError}
						/>
					</>
				}
			/>
			<LayerCard>
				<LayerCard.Primary className={rows.length === 0 ? undefined : "p-0"}>
					{rows.length === 0 ? (
						<LayerCard.Empty icon={<Activity />} title="没有 Insights" />
					) : (
						<Table data-testid="insight-list">
							<TableHeader>
								<TableRow>
									<TableHead>仓库</TableHead>
									<TableHead>健康</TableHead>
									<TableHead>Issues</TableHead>
									<TableHead>距上次推送</TableHead>
									<TableHead>机会</TableHead>
									<TableHead>告警</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((row) => (
									<TableRow key={row.name_with_owner}>
										<TableCell>
											<Link href={`/repos/${row.name_with_owner}`}>{row.name_with_owner}</Link>
										</TableCell>
										<TableCell>
											<Badge variant={healthBadgeVariant(row.health)}>
												{formatHealth(row.health)}
											</Badge>
										</TableCell>
										<TableCell className="tabular-nums">{row.open_issue_count}</TableCell>
										<TableCell className="tabular-nums">{row.days_since_push} 天</TableCell>
										<TableCell>
											{row.opportunities.length === 0 ? (
												"—"
											) : (
												<div className="flex flex-wrap gap-1">
													{row.opportunities.map((item) => (
														<Badge key={item} variant="secondary">
															{item}
														</Badge>
													))}
												</div>
											)}
										</TableCell>
										<TableCell>
											{row.alerts.length === 0 ? (
												"—"
											) : (
												<div className="flex flex-col gap-1">
													{row.alerts.map((alert) => (
														<Link key={alert.url} href={alert.url} target="_blank" rel="noreferrer">
															{alert.summary}
														</Link>
													))}
												</div>
											)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</LayerCard.Primary>
			</LayerCard>
		</div>
	);
}
