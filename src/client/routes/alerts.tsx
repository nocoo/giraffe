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
import { useEffect, useMemo, useState } from "react";
import { CandyBadge } from "../components/layout/candy-badge";
import {
	ResultCount,
	SnapshotDescription,
	TableScroll,
} from "../components/layout/collection-chrome";
import { IconLabel } from "../components/layout/icon-label";
import { Kpi, KpiRow } from "../components/layout/kpi";
import { ActiveFilters, Breakdown, OverviewCard } from "../components/layout/overview-cards";
import { TableSkeleton } from "../components/layout/page-skeleton";
import { ProjectLink } from "../components/layout/project-identity";
import { ShareBar } from "../components/layout/rank-bars";
import { SnapshotPending } from "../components/layout/snapshot-pending";
import { catchLoad } from "../lib/error-ui";
import { formatCount, severityBadgeVariant, sourceBadgeVariant } from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import {
	type AlertsSnapshot,
	alertsUnavailable,
	loadAlerts,
	visibleAlerts,
} from "../viewmodels/alerts";
import { alertsBoard, SEVERITIES } from "../viewmodels/boards";
import { shortRepo } from "../viewmodels/overview";

const NO_FILTERS = { severity: "", repo: "", source: "" };
const SEVERITY_LABELS: Record<string, string> = {
	critical: "严重",
	high: "高",
	medium: "中",
	low: "低",
	other: "其他",
};
const SEVERITY_COLORS: Record<string, string> = {
	critical: "hsl(var(--basalt-accent-8))",
	high: "color-mix(in srgb,hsl(var(--basalt-accent-8)) 55%,var(--color-giraffe-yellow))",
	medium: "var(--color-giraffe-yellow)",
	low: "color-mix(in srgb,var(--color-giraffe-yellow) 40%,var(--color-basalt-border))",
	other: "var(--color-basalt-muted-foreground)",
};

export function AlertsPage() {
	const [snap, setSnap] = useState<AlertsSnapshot | { missing: true } | null>(null);
	const [picked, setPicked] = useState(NO_FILTERS);
	const pick = (key: keyof typeof NO_FILTERS) => (value: string) =>
		setPicked((old) => ({ ...old, [key]: value }));
	const board = useMemo(
		() => (snap && !("missing" in snap) ? alertsBoard(visibleAlerts(snap), picked) : null),
		[snap, picked],
	);

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
				<PageHeader title="安全告警" description={PAGE_DESCRIPTIONS["/alerts"]} />
				<LayerCard>
					<LayerCard.Well>
						<SnapshotPending state={snap} />
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

	if (!board) return null;
	const items = board.rows;
	const all = visibleAlerts(snap);

	return (
		<div className="giraffe-page-motion space-y-6">
			<PageHeader
				title="安全告警"
				description={
					<SnapshotDescription
						description={PAGE_DESCRIPTIONS["/alerts"]}
						fetchedAt={snap.fetched_at}
					/>
				}
				actions={snap.truncated ? <CandyBadge tone="amber">已截断</CandyBadge> : null}
			/>
			<KpiRow>
				<Kpi icon={Bug} label="Dependabot" value={formatCount(snap.dependabot_open)} />
				<Kpi
					icon={ShieldAlert}
					label="Code scanning"
					value={formatCount(snap.code_scanning_open)}
				/>
			</KpiRow>
			{snap.truncated ? (
				<p className="giraffe-coverage-note" role="note">
					覆盖不完整：Dependabot 逐仓读取，Code scanning 只检查按名称排序的前 10
					个仓库，其余仓库的安全状态未知。显示为 0 不代表所有仓库都没有告警。
				</p>
			) : null}
			{all.length ? (
				<>
					<div className="giraffe-overview">
						<OverviewCard title="严重程度" hint="按 GitHub 给出的级别分组，点击筛选下方列表。">
							<ShareBar
								label="告警严重程度"
								legend={false}
								parts={board.severity.map((sv) => ({
									key: sv.key,
									label: SEVERITY_LABELS[sv.key] ?? sv.key,
									value: sv.value,
									color: SEVERITY_COLORS[sv.key] ?? "var(--color-basalt-border)",
								}))}
							/>
							<div className="mt-4">
								<Breakdown
									rows={SEVERITIES.map((k) => ({
										name: k,
										value: board.severity.find((sv) => sv.key === k)?.value ?? 0,
										color: SEVERITY_COLORS[k] ?? "var(--color-basalt-border)",
									}))}
									max={Math.max(1, ...board.severity.map((sv) => sv.value))}
									label="告警按严重程度"
									active={picked.severity}
									onSelect={pick("severity")}
									format={(k) => SEVERITY_LABELS[k] ?? k}
								/>
							</div>
						</OverviewCard>
						<OverviewCard title="按仓库" hint="告警最多的仓库，点击筛选。">
							<Breakdown
								rows={board.repos.rows}
								max={board.repos.max}
								label="告警按仓库"
								active={picked.repo}
								onSelect={pick("repo")}
								format={shortRepo}
								color="hsl(var(--basalt-accent-8))"
							/>
						</OverviewCard>
						<OverviewCard
							title="按来源"
							hint="Dependabot 依赖漏洞与 Code scanning 代码扫描，点击筛选。"
						>
							<Breakdown
								rows={board.sources.rows}
								max={board.sources.max}
								label="告警按来源"
								active={picked.source}
								onSelect={pick("source")}
							/>
						</OverviewCard>
					</div>
					<ActiveFilters
						filters={picked}
						labels={{ severity: "级别", repo: "仓库", source: "来源" }}
						format={{ severity: (k) => SEVERITY_LABELS[k] ?? k, repo: shortRepo }}
						onClear={(key) => setPicked((old) => (key ? { ...old, [key]: "" } : NO_FILTERS))}
					/>
				</>
			) : null}
			<SectionRule
				title={<IconLabel icon={ShieldAlert}>待处理告警</IconLabel>}
				actions={<ResultCount count={items.length} total={all.length} />}
			>
				{items.length === 0 ? (
					<LayerCard>
						<LayerCard.Well>
							<LayerCard.Empty
								icon={<ShieldAlert />}
								title={all.length ? "没有符合筛选的告警" : "已检查的仓库没有安全告警"}
								description={
									all.length
										? "清除筛选查看全部告警。"
										: snap.truncated
											? "仅代表已读取到的仓库；未覆盖仓库的状态未知。"
											: "可见仓库的当前快照中没有待处理告警。"
								}
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
														<ProjectLink
															repo={row.name_with_owner}
															className="text-basalt-muted-foreground"
														/>
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
