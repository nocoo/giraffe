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
import { CheckCheck, Inbox, Mail, MailCheck, MailOpen } from "lucide-react";
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
import { DATE_CELL, formatCount, formatDate, NUM_HEAD, reasonBadgeVariant } from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import { loadInbox, markRead, markReadAll, type NotificationsSnapshot } from "../viewmodels/inbox";
import { requestRefresh } from "../viewmodels/refresh";

export function InboxPage() {
	const [snap, setSnap] = useState<NotificationsSnapshot | { missing: true } | null>(null);
	const [marking, setMarking] = useState<string | null>(null);

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
			<div className="space-y-8">
				<PageHeader
					title="通知"
					description={PAGE_DESCRIPTIONS["/inbox"]}
					actions={
						<RefreshButton
							run={() => requestRefresh(["notifications"]).then(() => loadInbox().then(setSnap))}
							onError={onLoadError}
						/>
					}
				/>
				<LayerCard>
					<LayerCard.Well>
						<LayerCard.Empty
							icon={<Inbox />}
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

	if (!snap) {
		return (
			<div className="space-y-8">
				<PageHeader title="通知" description={PAGE_DESCRIPTIONS["/inbox"]} />
				<TableSkeleton label="加载通知" columns={6} />
			</div>
		);
	}

	const rows = snap.notifications;
	const unread = rows.filter((row) => row.unread).length;

	return (
		<div className="space-y-8">
			<PageHeader
				title="通知"
				description={
					<SnapshotDescription
						description={PAGE_DESCRIPTIONS["/inbox"]}
						fetchedAt={snap.fetched_at}
					/>
				}
				actions={
					<>
						{snap.truncated ? <CandyBadge tone="amber">已截断</CandyBadge> : null}
						<RefreshButton
							run={() => requestRefresh(["notifications"]).then(() => loadInbox().then(setSnap))}
							onError={onLoadError}
						/>
						<Button
							type="button"
							size="sm"
							icon={<CheckCheck className="size-3.5" aria-hidden="true" />}
							loading={marking === "all"}
							disabled={unread === 0 || marking !== null}
							onClick={() => {
								setMarking("all");
								void markReadAll(snap.account_id)
									.then((next) => {
										toast.success("已将全部通知标为已读");
										setSnap(next);
									})
									.catch(onLoadError)
									.finally(() => setMarking(null));
							}}
						>
							全部已读
						</Button>
					</>
				}
			/>
			<KpiRow>
				<Kpi icon={Mail} label="未读" value={formatCount(unread)} />
				<Kpi icon={MailOpen} label="全部" value={formatCount(rows.length)} />
			</KpiRow>
			<SectionRule title="收件箱" actions={<ResultCount count={rows.length} />}>
				<LayerCard>
					<LayerCard.Well {...(rows.length === 0 ? {} : { className: "p-0" })}>
						{rows.length === 0 ? (
							<LayerCard.Empty
								icon={<Inbox />}
								title="收件箱为空"
								description="新的 GitHub 通知将在下次刷新后出现在这里。"
							/>
						) : (
							<TableScroll label="通知列表">
								<Table className="min-w-[760px] [&_th]:whitespace-nowrap" data-testid="inbox-list">
									<TableHeader>
										<TableRow>
											<TableHead>状态</TableHead>

											<TableHead>通知 / 仓库</TableHead>
											<TableHead>原因</TableHead>
											<TableHead className={NUM_HEAD}>时间</TableHead>
											<TableHead className="text-right">操作</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{rows.map((row) => (
											<TableRow key={row.id} {...(row.unread ? { variant: "selected" } : {})}>
												<TableCell>
													{row.unread ? (
														<CandyBadge tone="sky" dot>
															未读
														</CandyBadge>
													) : (
														<span className="text-basalt-muted-foreground">已读</span>
													)}
												</TableCell>
												<TableCell className="w-[48%] min-w-64">
													<Link
														href={row.url}
														target="_blank"
														rel="noreferrer"
														className={`${row.unread ? "font-semibold" : "font-medium"} text-basalt-foreground [overflow-wrap:anywhere] hover:text-basalt-primary`}
													>
														{row.title}
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
													<CandyBadge tone={reasonBadgeVariant(row.reason)}>
														{row.reason}
													</CandyBadge>
												</TableCell>
												<TableCell className={DATE_CELL}>{formatDate(row.updated_at)}</TableCell>
												<TableCell className="text-right">
													{row.unread ? (
														<Button
															type="button"
															variant="secondary"
															size="sm"
															icon={<MailCheck className="size-3.5" aria-hidden="true" />}
															loading={marking === row.id}
															disabled={marking !== null}
															onClick={() => {
																setMarking(row.id);
																void markRead(row.id, snap.account_id)
																	.then((next) => {
																		toast.success("已标为已读");
																		setSnap(next);
																	})
																	.catch(onLoadError)
																	.finally(() => setMarking(null));
															}}
														>
															标为已读
														</Button>
													) : null}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</TableScroll>
						)}
					</LayerCard.Well>
				</LayerCard>
			</SectionRule>
		</div>
	);
}
