import { Badge, Link, StatStrip, toast } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@nocoo/basalt/components/table";
import { ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { PageSkeleton } from "../components/layout/page-skeleton";
import { PageToolbar } from "../components/layout/page-toolbar";
import { RefreshButton } from "../components/layout/refresh-button";
import { catchLoad, missingTitle } from "../lib/error-ui";
import { severityBadgeVariant } from "../lib/format";
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
			<div className="flex flex-col gap-4">
				<PageToolbar
					title="安全告警"
					description={PAGE_DESCRIPTIONS["/alerts"]}
					actions={
						<RefreshButton
							variant="default"
							run={() => requestRefresh(["alerts"]).then(() => loadAlerts().then(setSnap))}
							onError={onLoadError}
						/>
					}
				/>
				<LayerCard>
					<LayerCard.Primary>
						<LayerCard.Empty
							icon={<ShieldAlert />}
							title={missingTitle(snap)}
							description="先添加 PAT 或刷新。"
						/>
					</LayerCard.Primary>
				</LayerCard>
			</div>
		);
	}

	if (snap && alertsUnavailable(snap)) {
		return (
			<div className="flex flex-col gap-4">
				<PageToolbar title="安全告警" description={PAGE_DESCRIPTIONS["/alerts"]} />
				<LayerCard>
					<LayerCard.Primary>
						<LayerCard.Empty
							icon={<ShieldAlert />}
							title="无权限"
							description="当前 PAT 看不到安全告警。"
						/>
					</LayerCard.Primary>
				</LayerCard>
			</div>
		);
	}

	if (!snap) {
		return (
			<div className="flex flex-col gap-4">
				<PageToolbar title="安全告警" description={PAGE_DESCRIPTIONS["/alerts"]} />
				<PageSkeleton label="加载告警" />
			</div>
		);
	}

	const items = visibleAlerts(snap);

	return (
		<div className="flex flex-col gap-4">
			<PageToolbar
				title="安全告警"
				description={PAGE_DESCRIPTIONS["/alerts"]}
				actions={
					<>
						{snap.truncated ? <Badge variant="warning">已截断</Badge> : null}
						<RefreshButton
							run={() => requestRefresh(["alerts"]).then(() => loadAlerts().then(setSnap))}
							onError={onLoadError}
						/>
					</>
				}
			/>
			<StatStrip
				items={[
					{ label: "Dependabot 打开", value: snap.dependabot_open },
					{ label: "Code scanning 打开", value: snap.code_scanning_open },
				]}
			/>
			{items.length === 0 ? (
				<LayerCard>
					<LayerCard.Primary>
						<LayerCard.Empty icon={<ShieldAlert />} title="没有告警" />
					</LayerCard.Primary>
				</LayerCard>
			) : (
				<LayerCard>
					<LayerCard.Primary className="p-0">
						<Table data-testid="alert-list">
							<TableHeader>
								<TableRow>
									<TableHead>仓库</TableHead>
									<TableHead>来源</TableHead>
									<TableHead>级别</TableHead>
									<TableHead>摘要</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{items.map((row) => (
									<TableRow key={`${row.name_with_owner}:${row.url}`}>
										<TableCell className="text-basalt-muted-foreground">
											{row.name_with_owner}
										</TableCell>
										<TableCell>{row.source}</TableCell>
										<TableCell>
											<Badge variant={severityBadgeVariant(row.severity)}>{row.severity}</Badge>
										</TableCell>
										<TableCell>
											<Link href={row.url} target="_blank" rel="noreferrer">
												{row.summary}
											</Link>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</LayerCard.Primary>
				</LayerCard>
			)}
		</div>
	);
}
