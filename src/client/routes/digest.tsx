import { Link, toast } from "@nocoo/basalt";
import {
	ANIMATION_PROPS,
	cartesianAxisProps,
	chartTooltipProps,
	GRID_PROPS,
} from "@nocoo/basalt/charts/config";
import { ChartFrame } from "@nocoo/basalt/charts/frame";
import { Banner } from "@nocoo/basalt/components/banner";
import { ClipboardText } from "@nocoo/basalt/components/clipboard-text";
import { CodeBlock } from "@nocoo/basalt/components/code";
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
import { CircleDot, FileText, GitFork, Newspaper, Star } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { CandyBadge } from "../components/layout/candy-badge";
import { ChartBrick } from "../components/layout/chart-brick";
import {
	ResultCount,
	SnapshotDescription,
	TableScroll,
} from "../components/layout/collection-chrome";
import { IconLabel } from "../components/layout/icon-label";
import { Kpi, KpiRow } from "../components/layout/kpi";
import { TableSkeleton } from "../components/layout/page-skeleton";
import { SnapshotPending } from "../components/layout/snapshot-pending";
import { FLOW_COLORS } from "../lib/chart-theme";
import { catchLoad } from "../lib/error-ui";
import { formatCount, formatDelta, NUM_CELL, NUM_HEAD } from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import { digestBoard } from "../viewmodels/boards";
import { type DigestSnapshot, digestMarkdown, loadDigest } from "../viewmodels/digest";

export function DigestPage() {
	const [snap, setSnap] = useState<DigestSnapshot | { missing: true } | null>(null);

	useEffect(() => {
		void loadDigest()
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

	const markdown = useMemo(() => {
		if (!snap || "missing" in snap) {
			return "";
		}
		return digestMarkdown(snap);
	}, [snap]);

	if (snap && "missing" in snap) {
		return (
			<div className="space-y-8">
				<PageHeader title="日报" description={PAGE_DESCRIPTIONS["/digest"]} />
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
				<PageHeader title="日报" description={PAGE_DESCRIPTIONS["/digest"]} />
				<TableSkeleton label="加载日报" columns={4} />
			</div>
		);
	}

	const missing = snap.baseline_missing === true;
	const board = digestBoard(snap.repos, missing);
	// Without a baseline every change is unknown, so the full table stays visible as dashes.
	const listed = missing ? snap.repos : board.changed;

	return (
		<div
			className="giraffe-page-motion space-y-6"
			style={{ "--digest-rows": board.bars.length } as CSSProperties}
		>
			<PageHeader
				title="日报"
				description={
					<SnapshotDescription
						description={`${snap.day} · ${PAGE_DESCRIPTIONS["/digest"]}`}
						fetchedAt={snap.fetched_at}
					/>
				}
				actions={snap.truncated ? <CandyBadge tone="amber">已截断</CandyBadge> : null}
			/>
			{missing ? (
				<Banner
					variant="default"
					title="等待第一份对比数据"
					description="尚无昨天的基线。保留今天的数据，明天即可查看变化。"
				/>
			) : null}
			<KpiRow>
				<Kpi icon={Star} label="Stars 变化" value={formatDelta(snap.stars_delta, missing)} />
				<Kpi icon={GitFork} label="Forks 变化" value={formatDelta(snap.forks_delta, missing)} />
				<Kpi
					icon={CircleDot}
					label="Issues 变化"
					value={formatDelta(snap.open_issues_delta, missing)}
				/>
			</KpiRow>
			{board.bars.length ? (
				<ChartBrick
					title="Open Issue 变化"
					description="相对昨天每个仓库 open Issue 的增减。向右为增加（积压上升），向左为减少。"
				>
					<p className="giraffe-stat-inline mb-2">
						<span>
							增加 <strong>+{formatCount(board.issues.up)}</strong>
						</span>
						<span>
							减少 <strong>{formatCount(board.issues.down)}</strong>
						</span>
						<span>
							<strong>{formatCount(board.changed.length)}</strong>个仓库有变化 ·{" "}
							<strong>{formatCount(board.unchanged)}</strong>个无变化
						</span>
					</p>
					<ChartFrame
						ariaLabel="各仓库 open Issue 变化"
						size="w-full"
						className="giraffe-digest-plot"
						summary={
							<span className="sr-only">每个仓库相对昨天的 open Issue 变化，数值见下表。</span>
						}
					>
						<BarChart
							data={board.bars}
							layout="vertical"
							margin={{ top: 4, right: 24, bottom: 0, left: 0 }}
							barCategoryGap={3}
						>
							<CartesianGrid {...GRID_PROPS} horizontal={false} vertical />
							<XAxis
								type="number"
								{...cartesianAxisProps()}
								domain={[-board.issues.max, board.issues.max]}
								allowDecimals={false}
							/>
							<YAxis
								type="category"
								dataKey="name"
								{...cartesianAxisProps()}
								width={96}
								interval={0}
							/>
							<ReferenceLine x={0} stroke="var(--color-basalt-border)" />
							<Tooltip
								{...chartTooltipProps({ cursor: "bar", formatter: (v) => formatDelta(v, false) })}
							/>
							<Bar dataKey="issues" name="Open Issue 变化" radius={3} {...ANIMATION_PROPS}>
								{board.bars.map((b) => (
									<Cell
										key={b.repo}
										fill={b.issues > 0 ? FLOW_COLORS.opened : FLOW_COLORS.closed}
									/>
								))}
							</Bar>
						</BarChart>
					</ChartFrame>
				</ChartBrick>
			) : null}
			<SectionRule
				title={<IconLabel icon={Newspaper}>{missing ? "仓库变化" : "有变化的仓库"}</IconLabel>}
				actions={<ResultCount count={listed.length} total={snap.repos.length} />}
				hint={`${snap.day} · 相较前一天的数据${missing ? "" : "；无变化的仓库不列出"}`}
			>
				{listed.length > 0 ? (
					<LayerCard>
						<LayerCard.Well className="p-0">
							<TableScroll label="仓库变化列表">
								<Table className="min-w-[560px] [&_th]:whitespace-nowrap" data-testid="digest-list">
									<TableHeader>
										<TableRow>
											<TableHead>仓库</TableHead>
											<TableHead className={NUM_HEAD}>Stars</TableHead>
											<TableHead className={NUM_HEAD}>Forks</TableHead>
											<TableHead className={NUM_HEAD}>Issues</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{listed.map((row) => (
											<TableRow key={row.name_with_owner}>
												<TableCell>
													<Link href={`/repos/${row.name_with_owner}`}>{row.name_with_owner}</Link>
												</TableCell>
												<TableCell className={NUM_CELL}>
													{formatDelta(row.stars_delta, missing)}
												</TableCell>
												<TableCell className={NUM_CELL}>
													{formatDelta(row.forks_delta, missing)}
												</TableCell>
												<TableCell className={NUM_CELL}>
													{formatDelta(row.open_issues_delta, missing)}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</TableScroll>
						</LayerCard.Well>
					</LayerCard>
				) : (
					<LayerCard>
						<LayerCard.Well>
							<LayerCard.Empty
								icon={<Newspaper />}
								title={snap.repos.length ? "今天没有仓库变化" : "还没有仓库变化"}
								description={
									snap.repos.length
										? `${snap.repos.length} 个仓库的 Stars、Forks 与 open Issue 都与昨天相同。`
										: "刷新仓库数据后，日报会在这里汇总。"
								}
							/>
						</LayerCard.Well>
					</LayerCard>
				)}
			</SectionRule>
			{markdown ? (
				<SectionRule
					title={<IconLabel icon={FileText}>Markdown</IconLabel>}
					actions={<ClipboardText text="复制 Markdown" copyText={markdown} className="h-8" />}
				>
					<LayerCard>
						<LayerCard.Body>
							<CodeBlock
								className="max-h-80 whitespace-pre-wrap break-words text-sm leading-6"
								aria-label="日报 Markdown"
							>
								{markdown}
							</CodeBlock>
						</LayerCard.Body>
					</LayerCard>
				</SectionRule>
			) : null}
		</div>
	);
}
