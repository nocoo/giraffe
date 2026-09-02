import { Badge, Button, StatStrip, Toolbar, toast } from "@nocoo/basalt";
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
import { useEffect, useState } from "react";
import { catchLoad } from "../lib/error-ui";
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
		const missing = catchLoad(err, toast);
		if (missing) {
			setSnap(missing);
		}
	}

	useEffect(() => {
		void loadAlerts()
			.then(setSnap)
			.catch((err: unknown) => {
				const missing = catchLoad(err, toast);
				if (missing) {
					setSnap(missing);
				}
			});
	}, []);

	if (snap && "missing" in snap) {
		return (
			<div className="flex flex-col gap-4">
				<PageHeader title="安全告警" />
				<Empty title="没有快照" description="先添加 PAT 或刷新。" />
				<Button
					type="button"
					onClick={() => {
						void requestRefresh(["alerts"])
							.then(() => loadAlerts().then(setSnap))
							.catch(onLoadError);
					}}
				>
					刷新
				</Button>
			</div>
		);
	}

	if (snap && alertsUnavailable(snap)) {
		return (
			<div className="flex flex-col gap-4">
				<PageHeader title="安全告警" />
				<Empty title="无权限" />
			</div>
		);
	}

	const items = snap ? visibleAlerts(snap) : [];

	return (
		<div className="flex flex-col gap-4">
			<PageHeader title="安全告警" />
			{snap?.truncated ? <Badge>已截断</Badge> : null}
			{snap ? (
				<StatStrip
					items={[
						{ label: "Dependabot", value: snap.dependabot_open },
						{ label: "code scanning", value: snap.code_scanning_open },
					]}
				/>
			) : null}
			<Toolbar aria-label="安全告警工具条">
				<Button
					type="button"
					variant="secondary"
					onClick={() => {
						void requestRefresh(["alerts"])
							.then(() => loadAlerts().then(setSnap))
							.catch(onLoadError);
					}}
				>
					刷新
				</Button>
			</Toolbar>
			{items.length === 0 ? (
				<Empty title="没有告警" />
			) : (
				<Table data-testid="alert-list">
					<TableHeader>
						<TableRow>
							<TableHead>仓</TableHead>
							<TableHead>source</TableHead>
							<TableHead>severity</TableHead>
							<TableHead>summary</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{items.map((row) => (
							<TableRow key={`${row.name_with_owner}:${row.url}`}>
								<TableCell>{row.name_with_owner}</TableCell>
								<TableCell>{row.source}</TableCell>
								<TableCell>{row.severity}</TableCell>
								<TableCell>
									<a href={row.url} target="_blank" rel="noreferrer">
										{row.summary}
									</a>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</div>
	);
}
