import { Button, Link, toast } from "@nocoo/basalt";
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
import { CircleDot, GitFork, Newspaper, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { formatDelta, NUM_CELL, NUM_HEAD } from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import { type DigestSnapshot, digestMarkdown, loadDigest } from "../viewmodels/digest";
import { requestRefresh } from "../viewmodels/refresh";

export function DigestPage() {
	const [snap, setSnap] = useState<DigestSnapshot | { missing: true } | null>(null);

	function onLoadError(err: unknown): void {
		const missing = catchLoad(err, (message) => {
			toast.error(message);
		});
		if (missing) {
			setSnap(missing);
		}
	}

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
				<PageHeader
					title="日报"
					description={PAGE_DESCRIPTIONS["/digest"]}
					actions={
						<RefreshButton
							run={() => requestRefresh(["repos"]).then(() => loadDigest().then(setSnap))}
							onError={onLoadError}
						/>
					}
				/>
				<LayerCard>
					<LayerCard.Well>
						<LayerCard.Empty
							icon={<Newspaper />}
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
				<PageHeader title="日报" description={PAGE_DESCRIPTIONS["/digest"]} />
				<TableSkeleton label="加载日报" columns={4} />
			</div>
		);
	}

	const missing = snap.baseline_missing === true;

	return (
		<div className="space-y-8">
			<PageHeader
				title="日报"
				description={
					<SnapshotDescription
						description={`${snap.day} · ${PAGE_DESCRIPTIONS["/digest"]}`}
						fetchedAt={snap.fetched_at}
					/>
				}
				actions={
					<>
						{snap.truncated ? <CandyBadge tone="amber">已截断</CandyBadge> : null}
						<RefreshButton
							run={() => requestRefresh(["repos"]).then(() => loadDigest().then(setSnap))}
							onError={onLoadError}
						/>
					</>
				}
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
			<SectionRule
				title="仓库变化"
				actions={<ResultCount count={snap.repos.length} />}
				hint={`${snap.day} · 相较前一天的数据`}
			>
				{snap.repos.length > 0 ? (
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
										{snap.repos.map((row) => (
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
								title="还没有仓库变化"
								description="刷新仓库数据后，日报会在这里汇总。"
							/>
						</LayerCard.Well>
					</LayerCard>
				)}
			</SectionRule>
			{markdown ? (
				<SectionRule
					title="Markdown"
					actions={<ClipboardText text="复制 Markdown" copyText={markdown} className="h-8" />}
				>
					<LayerCard>
						<LayerCard.Body>
							<CodeBlock
								className="max-h-80 whitespace-pre-wrap break-words text-xs leading-6"
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
