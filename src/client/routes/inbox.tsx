import { Badge, Button, Link, toast } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@nocoo/basalt/components/table";
import { Inbox } from "lucide-react";
import { useEffect, useState } from "react";
import { PageSkeleton } from "../components/layout/page-skeleton";
import { PageToolbar } from "../components/layout/page-toolbar";
import { RefreshButton } from "../components/layout/refresh-button";
import { catchLoad, missingTitle } from "../lib/error-ui";
import { formatDate } from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import { loadInbox, markRead, markReadAll, type NotificationsSnapshot } from "../viewmodels/inbox";
import { requestRefresh } from "../viewmodels/refresh";

export function InboxPage() {
	const [snap, setSnap] = useState<NotificationsSnapshot | { missing: true } | null>(null);

	function onLoadError(err: unknown): void {
		const missing = catchLoad(err, (message) => {
			toast.error(message);
		});
		if (missing) {
			setSnap(missing);
		}
	}

	useEffect(() => {
		void loadInbox()
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
					title="通知"
					description={PAGE_DESCRIPTIONS["/inbox"]}
					actions={
						<RefreshButton
							variant="default"
							run={() => requestRefresh(["notifications"]).then(() => loadInbox().then(setSnap))}
							onError={onLoadError}
						/>
					}
				/>
				<LayerCard>
					<LayerCard.Primary>
						<LayerCard.Empty
							icon={<Inbox />}
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
				<PageToolbar title="通知" description={PAGE_DESCRIPTIONS["/inbox"]} />
				<PageSkeleton label="加载通知" />
			</div>
		);
	}

	const rows = snap.notifications;
	const unread = rows.filter((row) => row.unread).length;

	return (
		<div className="flex flex-col gap-4">
			<PageToolbar
				title="通知"
				description={PAGE_DESCRIPTIONS["/inbox"]}
				actions={
					<>
						{snap.truncated ? <Badge variant="warning">已截断</Badge> : null}
						{unread > 0 ? <Badge variant="info">{unread} 未读</Badge> : null}
						<RefreshButton
							run={() => requestRefresh(["notifications"]).then(() => loadInbox().then(setSnap))}
							onError={onLoadError}
						/>
						<Button
							type="button"
							variant="secondary"
							disabled={unread === 0}
							onClick={() => {
								void markReadAll(snap.account_id)
									.then((next) => {
										toast.success("已全部已读");
										setSnap(next);
									})
									.catch(onLoadError);
							}}
						>
							全部已读
						</Button>
					</>
				}
			/>
			<LayerCard>
				<LayerCard.Primary className={rows.length === 0 ? undefined : "p-0"}>
					{rows.length === 0 ? (
						<LayerCard.Empty icon={<Inbox />} title="没有通知" />
					) : (
						<Table data-testid="inbox-list">
							<TableHeader>
								<TableRow>
									<TableHead>状态</TableHead>
									<TableHead>仓库</TableHead>
									<TableHead>标题</TableHead>
									<TableHead>原因</TableHead>
									<TableHead>时间</TableHead>
									<TableHead />
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((row) => (
									<TableRow key={row.id}>
										<TableCell>
											{row.unread ? (
												<Badge variant="info" dot>
													未读
												</Badge>
											) : (
												<span className="text-basalt-muted-foreground">已读</span>
											)}
										</TableCell>
										<TableCell className="text-basalt-muted-foreground">
											{row.name_with_owner}
										</TableCell>
										<TableCell>
											<Link href={row.url} target="_blank" rel="noreferrer">
												{row.title}
											</Link>
										</TableCell>
										<TableCell>{row.reason}</TableCell>
										<TableCell className="text-basalt-muted-foreground">
											{formatDate(row.updated_at)}
										</TableCell>
										<TableCell>
											<Button
												type="button"
												variant="secondary"
												disabled={!row.unread}
												onClick={() => {
													void markRead(row.id, snap.account_id)
														.then((next) => {
															toast.success("已读");
															setSnap(next);
														})
														.catch(onLoadError);
												}}
											>
												已读
											</Button>
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
