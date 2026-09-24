import { Button, Link, SegmentControl, toast } from "@nocoo/basalt";
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
import { TablePager } from "@nocoo/basalt/components/table-pager";
import { CheckCheck, Inbox, MailCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CandyBadge } from "../components/layout/candy-badge";
import {
	ResultCount,
	SnapshotDescription,
	TableScroll,
} from "../components/layout/collection-chrome";
import { IconLabel } from "../components/layout/icon-label";
import {
	ActiveFilters,
	Breakdown,
	CountBars,
	OverviewCard,
} from "../components/layout/overview-cards";
import { TableSkeleton } from "../components/layout/page-skeleton";
import { ProjectLink } from "../components/layout/project-identity";
import { INLINE_SEGMENT } from "../components/layout/segment";
import { SnapshotPending } from "../components/layout/snapshot-pending";
import { chartColor } from "../lib/chart-theme";
import { catchLoad } from "../lib/error-ui";
import { DATE_CELL, formatCount, formatDate, NUM_HEAD, reasonBadgeVariant } from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import { inboxBoard, primaryOwner } from "../viewmodels/boards";
import { loadInbox, markRead, markReadAll, type NotificationsSnapshot } from "../viewmodels/inbox";
import { shortRepo } from "../viewmodels/overview";

const NO_FILTERS = { reason: "", repo: "", unread: "" };
const PAGE_SIZE = 50;

export function InboxPage() {
	const [snap, setSnap] = useState<NotificationsSnapshot | { missing: true } | null>(null);
	const [marking, setMarking] = useState<string | null>(null);
	const [picked, setPicked] = useState(NO_FILTERS);
	const [page, setPage] = useState(1);
	const pick = (key: keyof typeof NO_FILTERS) => (value: string) => {
		setPicked((old) => ({ ...old, [key]: value }));
		setPage(1);
	};
	const board = useMemo(
		() =>
			snap && !("missing" in snap)
				? inboxBoard(snap.notifications, snap.fetched_at, primaryOwner(snap.notifications), picked)
				: null,
		[snap, picked],
	);

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
				<PageHeader title="通知" description={PAGE_DESCRIPTIONS["/inbox"]} />
				<LayerCard>
					<LayerCard.Well>
						<SnapshotPending state={snap} />
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

	if (!board) return null;
	const unread = snap.notifications.filter((row) => row.unread).length;
	const pages = Math.max(1, Math.ceil(board.rows.length / PAGE_SIZE));
	const current = Math.min(page, pages);
	const rows = board.rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
	const reasonColor = (reason: string) => chartColor(board.daily.keys.indexOf(reason));

	return (
		<div className="giraffe-page-motion space-y-6">
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
			<div className="giraffe-stat-inline">
				<span>
					<strong>{formatCount(unread)}</strong>未读 / {formatCount(snap.notifications.length)} 条
				</span>
				<span>
					<strong>{formatCount(board.repos.rows.reduce((n, r) => n + (r.other ?? 1), 0))}</strong>
					个仓库
				</span>
				<span>
					<strong>{formatCount(board.external)}</strong>条来自他人仓库
				</span>
			</div>
			{snap.notifications.length ? (
				<>
					<div className="giraffe-overview">
						<OverviewCard
							title="近 30 天通知"
							hint="按更新日期、按原因堆叠。柱越高说明当天需要处理的通知越多。"
						>
							<CountBars
								data={board.daily.points}
								series={board.daily.keys.map((k) => ({ key: k, label: k, color: reasonColor(k) }))}
								label="近 30 天通知按原因"
								xFormat={(v) => v.slice(5)}
								className="h-56 w-full"
							/>
						</OverviewCard>
						<OverviewCard
							title="按原因"
							hint="GitHub 通知原因：author 为你创建的线程，subscribed 为关注的仓库。点击筛选。"
						>
							<Breakdown
								rows={board.reasons.rows.map((r) => ({ ...r, color: reasonColor(r.name) }))}
								max={board.reasons.max}
								label="通知按原因"
								active={picked.reason}
								onSelect={pick("reason")}
							/>
						</OverviewCard>
						<OverviewCard title="按仓库" hint="通知最多的仓库，点击筛选；其余合并为「其他」。">
							<Breakdown
								rows={board.repos.rows}
								max={board.repos.max}
								label="通知按仓库"
								active={picked.repo}
								onSelect={pick("repo")}
								format={(name) =>
									name.startsWith(`${primaryOwner(snap.notifications)}/`) ? shortRepo(name) : name
								}
							/>
						</OverviewCard>
					</div>
					<ActiveFilters
						filters={picked}
						labels={{ reason: "原因", repo: "仓库", unread: "状态" }}
						format={{ unread: (v) => (v === "unread" ? "未读" : "已读") }}
						onClear={(key) => {
							setPicked((old) => (key ? { ...old, [key]: "" } : NO_FILTERS));
							setPage(1);
						}}
					/>
				</>
			) : null}
			<SectionRule
				title={<IconLabel icon={Inbox}>收件箱</IconLabel>}
				actions={
					<>
						<ResultCount count={board.rows.length} total={snap.notifications.length} />
						<SegmentControl
							legend="阅读状态"
							className={INLINE_SEGMENT}
							value={picked.unread || "all"}
							onValueChange={(value) => pick("unread")(value === "all" ? "" : value)}
							options={[
								{ value: "all", label: "全部" },
								{ value: "unread", label: "未读" },
								{ value: "read", label: "已读" },
							]}
						/>
					</>
				}
			>
				<LayerCard>
					<LayerCard.Well {...(rows.length === 0 ? {} : { className: "p-0" })}>
						{rows.length === 0 ? (
							<LayerCard.Empty
								icon={<Inbox />}
								title={snap.notifications.length ? "没有符合筛选的通知" : "收件箱为空"}
								description="新的 GitHub 通知将在下次刷新后出现在这里。"
							/>
						) : (
							<>
								<TableScroll label="通知列表">
									<Table className="giraffe-data-table min-w-[760px]" data-testid="inbox-list">
										<TableHeader>
											<TableRow>
												<TableHead>状态</TableHead>

												<TableHead data-grow>通知 / 仓库</TableHead>
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
															className={`${row.unread ? "font-semibold" : "font-medium"} text-basalt-foreground giraffe-wrap [overflow-wrap:anywhere] hover:text-basalt-primary`}
														>
															{row.title}
														</Link>
														<p className="mt-1 text-xs">
															<ProjectLink
																repo={row.name_with_owner}
																className="text-basalt-muted-foreground"
															/>
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
								{pages > 1 ? (
									<TablePager
										className="px-4 py-3"
										page={current}
										pageSize={PAGE_SIZE}
										totalCount={board.rows.length}
										onPageChange={setPage}
									/>
								) : null}
							</>
						)}
					</LayerCard.Well>
				</LayerCard>
			</SectionRule>
		</div>
	);
}
