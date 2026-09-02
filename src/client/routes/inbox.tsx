import { Badge, Button, Toolbar, toast } from "@nocoo/basalt";
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
import { RefreshButton } from "../components/layout/refresh-button";
import { catchLoad } from "../lib/error-ui";
import { loadInbox, markRead, markReadAll, type NotificationsSnapshot } from "../viewmodels/inbox";
import { requestRefresh } from "../viewmodels/refresh";

export function InboxPage() {
	const [snap, setSnap] = useState<NotificationsSnapshot | { missing: true } | null>(null);

	function onLoadError(err: unknown): void {
		const missing = catchLoad(err, toast);
		if (missing) {
			setSnap(missing);
		}
	}

	useEffect(() => {
		void loadInbox()
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
				<PageHeader title="通知" />
				<Empty title="没有快照" description="先添加 PAT 或刷新。" />
				<RefreshButton
					variant="default"
					run={() => requestRefresh(["notifications"]).then(() => loadInbox().then(setSnap))}
					onError={onLoadError}
				/>
			</div>
		);
	}

	const rows = snap?.notifications ?? [];

	return (
		<div className="flex flex-col gap-4">
			<PageHeader title="通知" />
			{snap?.truncated ? <Badge>已截断</Badge> : null}
			<Toolbar aria-label="通知工具条">
				<RefreshButton
					run={() => requestRefresh(["notifications"]).then(() => loadInbox().then(setSnap))}
					onError={onLoadError}
				/>
				<Button
					type="button"
					onClick={() => {
						void markReadAll()
							.then((next) => {
								toast("已全部已读");
								setSnap(next);
							})
							.catch(onLoadError);
					}}
				>
					全部已读
				</Button>
			</Toolbar>
			{rows.length === 0 ? (
				<Empty title="没有通知" />
			) : (
				<Table data-testid="inbox-list">
					<TableHeader>
						<TableRow>
							<TableHead>未读</TableHead>
							<TableHead>仓</TableHead>
							<TableHead>title</TableHead>
							<TableHead>reason</TableHead>
							<TableHead>时间</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row) => (
							<TableRow key={row.id}>
								<TableCell>{row.unread ? "是" : "否"}</TableCell>
								<TableCell>{row.name_with_owner}</TableCell>
								<TableCell>
									<a href={row.url} target="_blank" rel="noreferrer">
										{row.title}
									</a>
								</TableCell>
								<TableCell>{row.reason}</TableCell>
								<TableCell>{row.updated_at}</TableCell>
								<TableCell>
									<Button
										type="button"
										variant="secondary"
										disabled={!row.unread}
										onClick={() => {
											void markRead(row.id)
												.then((next) => {
													toast("已读");
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
		</div>
	);
}
