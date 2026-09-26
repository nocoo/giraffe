import { Link, toast } from "@nocoo/basalt";
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
import { ListPageSkeleton } from "../components/layout/page-skeleton";
import { ProjectLink } from "../components/layout/project-identity";
import { ShareBar } from "../components/layout/rank-bars";
import { catchLoad } from "../lib/error-ui";
import { formatCount, severityBadgeVariant, sourceBadgeVariant } from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import { type AlertsSnapshot, loadAlerts } from "../viewmodels/alerts";
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
		() => (snap && !("missing" in snap) ? alertsBoard(snap.items, picked) : null),
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

	if (snap && ("missing" in snap || ((snap.unavailable || snap.truncated) && !snap.items.length))) {
		return (
			<div className="space-y-8">
				<PageHeader title="安全告警" description={PAGE_DESCRIPTIONS["/alerts"]} />
				<LayerCard>
					<LayerCard.Empty icon={<ShieldAlert />} title="暂无告警数据" />
				</LayerCard>
			</div>
		);
	}

	if (!snap) {
		return (
			<div className="space-y-8">
				<PageHeader title="安全告警" description={PAGE_DESCRIPTIONS["/alerts"]} />
				<ListPageSkeleton label="加载告警" cards={["rank", "rank", "rank"]} columns={3} />
			</div>
		);
	}

	if (!board) return null;
	const items = board.rows;
	const all = snap.items;

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
			/>
			<KpiRow>
				<Kpi
					icon={Bug}
					label="Dependabot"
					value={
						(snap.unavailable || snap.truncated) && !snap.dependabot_open
							? "—"
							: formatCount(snap.dependabot_open)
					}
				/>
				<Kpi
					icon={ShieldAlert}
					label="Code scanning"
					value={
						(snap.unavailable || snap.truncated) && !snap.code_scanning_open
							? "—"
							: formatCount(snap.code_scanning_open)
					}
				/>
			</KpiRow>
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
								title={all.length ? "没有符合筛选的告警" : "暂无告警数据"}
								{...(all.length ? { description: "清除筛选查看全部告警。" } : {})}
							/>
						</LayerCard.Well>
					</LayerCard>
				) : (
					<LayerCard>
						<LayerCard.Well className="p-0">
							<TableScroll label="安全告警列表">
								<Table className="giraffe-data-table min-w-[680px]" data-testid="alert-list">
									<TableHeader>
										<TableRow>
											<TableHead data-grow>告警 / 仓库</TableHead>
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
														className="font-medium text-basalt-foreground giraffe-wrap [overflow-wrap:anywhere] hover:text-basalt-primary"
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
