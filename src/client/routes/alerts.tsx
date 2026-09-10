import { Button, Link, toast } from "@nocoo/basalt";
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
import { Bug, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { CandyBadge } from "../components/layout/candy-badge";
import {
	ResultCount,
	SnapshotDescription,
	TableScroll,
} from "../components/layout/collection-chrome";
import { Kpi, KpiRow } from "../components/layout/kpi";
import { TableSkeleton } from "../components/layout/page-skeleton";
import { RefreshButton } from "../components/layout/refresh-button";
import { catchLoad, missingTitle } from "../lib/error-ui";
import { formatCount, severityBadgeVariant, sourceBadgeVariant } from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import {
	type AlertsSnapshot,
	alertsUnavailable,
	loadAlerts,
	visibleAlerts,
} from "../viewmodels/alerts";
import { requestRefresh } from "../viewmodels/refresh";

export function AlertsPage() {
	const [snap, setSnap] = useState<AlertsSnapshot | { missing: true } | null>(null);

	function onLoadError(err: unknown): void {
		const missing = catchLoad(err, (message) => {
			toast.error(message);
		});
		if (missing) {
			setSnap(missing);
		}
	}

	useEffect(() => {
		void loadAlerts()
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

	if (snap && "missing" in snap) {
		return (
			<div className="space-y-8">
				<PageHeader
					title="安全告警"
					description={PAGE_DESCRIPTIONS["/alerts"]}
					actions={
						<RefreshButton
							run={() => requestRefresh(["alerts"]).then(() => loadAlerts().then(setSnap))}
							onError={onLoadError}
						/>
					}
				/>
				<LayerCard>
					<LayerCard.Well>
						<LayerCard.Empty
							icon={<ShieldAlert />}
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

	if (snap && alertsUnavailable(snap)) {
		return (
			<div className="space-y-8">
				<PageHeader title="安全告警" description={PAGE_DESCRIPTIONS["/alerts"]} />
				<LayerCard>
					<LayerCard.Well>
						<LayerCard.Empty
							icon={<ShieldAlert />}
							title="无权限"
							description="当前 PAT 看不到安全告警。"
							action={
								<Button variant="secondary" size="sm" asChild>
									<Link href="/settings">检查账号权限</Link>
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
				<PageHeader title="安全告警" description={PAGE_DESCRIPTIONS["/alerts"]} />
				<TableSkeleton label="加载告警" columns={4} />
			</div>
		);
	}

	const items = visibleAlerts(snap);

	return (
		<div className="space-y-8">
			<PageHeader
				title="安全告警"
				description={
					<SnapshotDescription
						description={PAGE_DESCRIPTIONS["/alerts"]}
						fetchedAt={snap.fetched_at}
					/>
				}
				actions={
					<>
						{snap.truncated ? <CandyBadge tone="amber">已截断</CandyBadge> : null}
						<RefreshButton
							run={() => requestRefresh(["alerts"]).then(() => loadAlerts().then(setSnap))}
							onError={onLoadError}
						/>
					</>
				}
			/>
			<KpiRow>
				<Kpi icon={Bug} label="Dependabot" value={formatCount(snap.dependabot_open)} />
				<Kpi
					icon={ShieldAlert}
					label="Code scanning"
					value={formatCount(snap.code_scanning_open)}
				/>
			</KpiRow>
			<SectionRule title="待处理告警" actions={<ResultCount count={items.length} />}>
				{items.length === 0 ? (
					<LayerCard>
						<LayerCard.Well>
							<LayerCard.Empty
								icon={<ShieldAlert />}
								title="当前没有安全告警"
								description="可见仓库的当前快照中没有待处理告警。"
							/>
						</LayerCard.Well>
					</LayerCard>
				) : (
					<LayerCard>
						<LayerCard.Well className="p-0">
							<TableScroll label="安全告警列表">
								<Table className="min-w-[680px] [&_th]:whitespace-nowrap" data-testid="alert-list">
									<TableHeader>
										<TableRow>
											<TableHead>告警 / 仓库</TableHead>
											<TableHead>来源</TableHead>
											<TableHead>级别</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{items.map((row) => (
											<TableRow key={`${row.name_with_owner}:${row.url}`}>
												<TableCell className="w-[60%] min-w-64">
													<Link
														href={row.url}
														target="_blank"
														rel="noreferrer"
														className="font-medium text-basalt-foreground [overflow-wrap:anywhere] hover:text-basalt-primary"
													>
														{row.summary}
													</Link>
													<p className="mt-1 text-xs">
														<Link
															href={`/repos/${row.name_with_owner}`}
															className="text-basalt-muted-foreground"
														>
															{row.name_with_owner}
														</Link>
													</p>
												</TableCell>
												<TableCell>
													<CandyBadge tone={sourceBadgeVariant(row.source)}>
														{row.source}
													</CandyBadge>
												</TableCell>
												<TableCell>
													<CandyBadge tone={severityBadgeVariant(row.severity)}>
														{row.severity}
													</CandyBadge>
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</TableScroll>
						</LayerCard.Well>
					</LayerCard>
				)}
			</SectionRule>
		</div>
	);
}
