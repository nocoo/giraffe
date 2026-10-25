import { Button, Link, SegmentControl } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@nocoo/basalt/components/table";
import { ArrowUpRight } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { FactoryCoverage, FactoryEvent, FactoryStreamName } from "../../lib/factory-types";
import { CandyBadge } from "../components/layout/candy-badge";
import { TableScroll } from "../components/layout/collection-chrome";
import { TableSkeleton } from "../components/layout/page-skeleton";
import { SelectField } from "../components/layout/select-field";
import { LabelChips, PersonCell } from "../components/layout/table-chrome";
import {
	DATE_CELL,
	formatConclusion,
	formatCount,
	formatDate,
	formatPreciseDate,
	formatReview,
	NUM_HEAD,
	reviewBadgeVariant,
} from "../lib/format";
import {
	factoryError,
	loadFactoryDetail,
	STATUS_LABELS,
	STREAM_LABELS,
} from "../viewmodels/factory";
import {
	checksStatus,
	issueReason,
	recordNumber,
	recordStateOptions,
	recordStatus,
	runDuration,
} from "../viewmodels/repo-factory";

const PAGE_SIZE = 100;

type Column = {
	head: string;
	className?: string;
	headClassName?: string;
	cell: (event: FactoryEvent) => ReactNode;
};

function TitleCell({ event, meta }: { event: FactoryEvent; meta?: string }) {
	return (
		<span className="flex flex-wrap items-baseline gap-x-2">
			<Link
				href={event.url}
				target="_blank"
				rel="noreferrer"
				className="font-medium text-basalt-foreground giraffe-wrap [overflow-wrap:anywhere] hover:text-basalt-primary"
			>
				{event.title || event.id}
			</Link>
			{meta ? (
				<span className="text-xs tabular-nums text-basalt-muted-foreground">{meta}</span>
			) : null}
		</span>
	);
}

function StatusChips({ event }: { event: FactoryEvent }) {
	const status = recordStatus(event.state);
	return (
		<span className="flex flex-wrap gap-1">
			<CandyBadge tone={status.tone}>{status.label}</CandyBadge>
			{event.draft ? <CandyBadge tone="purple">草稿</CandyBadge> : null}
			{event.dependency ? <CandyBadge tone="sky">依赖</CandyBadge> : null}
			{event.bot ? <CandyBadge tone="gray">机器人</CandyBadge> : null}
		</span>
	);
}

function ReviewCell({ event }: { event: FactoryEvent }) {
	const checks = checksStatus(event.checks?.state);
	return (
		<span className="flex flex-wrap gap-1">
			{event.review ? (
				<CandyBadge tone={reviewBadgeVariant(event.review)}>
					{formatReview(event.review)}
				</CandyBadge>
			) : null}
			{checks ? <CandyBadge tone={checks.tone}>{checks.label}</CandyBadge> : null}
			{!event.review && !checks ? <span className="text-basalt-muted-foreground">—</span> : null}
		</span>
	);
}

function TimeCell({ value }: { value: string | null | undefined }) {
	return <span className={DATE_CELL}>{value ? formatDate(value) : "—"}</span>;
}

const SEVERITY_TONES = {
	critical: "red",
	high: "orange",
	medium: "amber",
	low: "gray",
} as const;

function columns(stream: FactoryStreamName): Column[] {
	const title: Column = {
		head: "记录",
		cell: (event) => {
			if (stream === "actions") {
				return <TitleCell event={event} meta={event.activityRun?.path ?? event.path ?? ""} />;
			}
			if (stream === "releases") {
				return <TitleCell event={event} meta={event.tag_name ?? ""} />;
			}
			if (stream === "dependencies") {
				return (
					<TitleCell event={event} meta={[event.path, event.job].filter(Boolean).join(" · ")} />
				);
			}
			if (stream === "commits") return <TitleCell event={event} />;
			const number = recordNumber(event);
			const base = stream === "prs" && event.base_ref ? ` · ${event.base_ref}` : "";
			return <TitleCell event={event} meta={`${number}${base}`} />;
		},
	};
	const author: Column = {
		head: "作者",
		cell: (event) => <PersonCell login={event.author} />,
	};
	switch (stream) {
		case "prs":
			return [
				title,
				{ head: "状态", cell: (event) => <StatusChips event={event} /> },
				{ head: "审查 / CI", cell: (event) => <ReviewCell event={event} /> },
				author,
				{
					head: "合并 / 更新",
					headClassName: NUM_HEAD,
					cell: (event) => {
						const [label, at] = event.mergedAt
							? ["合并", event.mergedAt]
							: event.closedAt
								? ["关闭", event.closedAt]
								: ["更新", event.updatedAt ?? event.at];
						const actor = event.mergedAt ? event.merged_by : null;
						return (
							<span className="text-xs tabular-nums text-basalt-muted-foreground">
								{label} {at ? formatDate(at) : "—"}
								{actor ? ` · ${actor}` : ""}
							</span>
						);
					},
				},
			];
		case "issues":
			return [
				title,
				{ head: "状态", cell: (event) => <StatusChips event={event} /> },
				{
					head: "标签",
					cell: (event) => <LabelChips labels={event.labels ?? []} wrap={false} />,
				},
				author,
				{
					head: "创建",
					headClassName: NUM_HEAD,
					cell: (event) => <TimeCell value={event.createdAt} />,
				},
				{
					head: "关闭",
					headClassName: NUM_HEAD,
					cell: (event) => (
						<span className="text-xs text-basalt-muted-foreground">
							{event.closedAt
								? `${formatDate(event.closedAt)}${event.closed_by ? ` · ${event.closed_by}` : ""}`
								: issueReason(event.state_reason) || "—"}
						</span>
					),
				},
			];
		case "actions":
			return [
				title,
				{
					head: "结论",
					cell: (event) => (
						<CandyBadge
							tone={
								event.conclusion === "success"
									? "green"
									: event.conclusion === "failure"
										? "red"
										: "gray"
							}
						>
							{formatConclusion(event.conclusion ?? null)}
						</CandyBadge>
					),
				},
				{
					head: "分支",
					cell: (event) => (
						<span className="text-xs text-basalt-muted-foreground">
							{event.activityRun?.head_branch ?? "—"}
						</span>
					),
				},
				{
					head: "尝试",
					headClassName: NUM_HEAD,
					cell: (event) => <span className="text-xs">#{event.activityRun?.run_attempt ?? 1}</span>,
				},
				{
					head: "耗时",
					headClassName: NUM_HEAD,
					cell: (event) => <span className="text-xs">{runDuration(event)}</span>,
				},
				{ head: "时间", headClassName: NUM_HEAD, cell: (event) => <TimeCell value={event.at} /> },
			];
		case "releases":
			return [
				title,
				{ head: "状态", cell: (event) => <StatusChips event={event} /> },
				author,
				{ head: "发布", headClassName: NUM_HEAD, cell: (event) => <TimeCell value={event.at} /> },
			];
		case "commits":
			return [
				title,
				author,
				{
					head: "提交时间",
					headClassName: NUM_HEAD,
					cell: (event) => <TimeCell value={event.at} />,
				},
			];
		case "alerts":
			return [
				title,
				{
					head: "严重级别",
					cell: (event) => (
						<CandyBadge
							tone={
								(event.severity && SEVERITY_TONES[event.severity as keyof typeof SEVERITY_TONES]) ||
								"gray"
							}
						>
							{event.severity ?? "—"}
						</CandyBadge>
					),
				},
				{ head: "状态", cell: (event) => <StatusChips event={event} /> },
				{ head: "时间", headClassName: NUM_HEAD, cell: (event) => <TimeCell value={event.at} /> },
			];
		default:
			return [
				title,
				{
					head: "版本",
					cell: (event) => (
						<span className="font-mono text-xs text-basalt-muted-foreground">
							{event.version ? event.version.slice(0, 12) : "—"}
						</span>
					),
				},
				{
					head: "",
					headClassName: NUM_HEAD,
					cell: (event) => (
						<Link href={event.url} target="_blank" rel="noreferrer" title="打开引用文件">
							<ArrowUpRight className="size-3.5" />
						</Link>
					),
				},
			];
	}
}

export function RepoFactoryTab({
	repo,
	days,
	stream,
	onStream,
}: {
	repo: string;
	days: string[];
	stream: FactoryStreamName;
	onStream: (stream: FactoryStreamName) => void;
}) {
	const [page, setPage] = useState(1);
	const [state, setState] = useState("");
	const [day, setDay] = useState("");
	const [items, setItems] = useState<FactoryEvent[]>([]);
	const [coverage, setCoverage] = useState<FactoryCoverage | null>(null);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError("");
		void loadFactoryDetail(repo, stream, page, state, day, "all")
			.then((detail) => {
				if (cancelled) return;
				if (!detail) {
					setError("账号已切换，请重新加载页面。");
				} else {
					setItems(detail.items);
					setCoverage(detail.coverage);
					setTotal(detail.total);
				}
				setLoading(false);
			})
			.catch((cause: unknown) => {
				if (cancelled) return;
				setError(factoryError(cause));
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [repo, stream, page, state, day]);

	const stateOptions = recordStateOptions(stream);
	const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const headers = columns(stream);

	return (
		<div className="flex flex-col gap-3">
			<div className="factory-toolbar">
				<SegmentControl
					legend="记录类型"
					value={stream}
					onValueChange={(value) => {
						onStream(value as FactoryStreamName);
						setPage(1);
						setState("");
					}}
					options={(Object.keys(STREAM_LABELS) as FactoryStreamName[]).map((value) => ({
						value,
						label: STREAM_LABELS[value],
					}))}
				/>
				{stateOptions.length > 1 ? (
					<SelectField
						label="状态"
						value={state}
						onValueChange={(value) => {
							setState(value);
							setPage(1);
						}}
						options={stateOptions}
					/>
				) : null}
				{days.length ? (
					<SelectField
						label="记录日期（本地）"
						value={day}
						onValueChange={(value) => {
							setDay(value);
							setPage(1);
						}}
						options={[
							{ value: "", label: "全部日期" },
							...days.map((date) => ({ value: date, label: date })),
						]}
					/>
				) : null}
			</div>
			<p className="text-xs text-basalt-muted-foreground">
				来自软件工厂的窗口内记录，含全部状态与采集覆盖；不是 GitHub 的实时视图。
			</p>
			{loading ? null : (
				<div className="factory-provenance">
					{coverage ? (
						<span>
							覆盖 <strong>{STATUS_LABELS[coverage.status]}</strong>
						</span>
					) : null}
					<span>{formatCount(total)} 条观察记录</span>
					<span>
						第 {page}/{pages} 页
					</span>
					{coverage?.fetchedAt ? <span>获取于 {formatPreciseDate(coverage.fetchedAt)}</span> : null}
					{coverage?.source ? (
						<span className="max-w-[34rem] truncate" title={coverage.source}>
							来源 {coverage.source}
						</span>
					) : null}
				</div>
			)}
			{!loading && coverage?.reason ? <p className="factory-notice">{coverage.reason}</p> : null}
			<LayerCard>
				<LayerCard.Well className="p-0">
					{error ? (
						<p role="alert" className="px-4 py-6 text-sm">
							{error}
						</p>
					) : loading ? (
						<TableSkeleton label="加载工厂记录" columns={headers.length} rows={6} />
					) : items.length === 0 ? (
						<LayerCard.Empty
							title="没有符合筛选的记录"
							description={
								coverage?.status === "complete"
									? "该端点范围内没有记录。"
									: "尚无可读记录；不代表 GitHub 中为零。"
							}
						/>
					) : (
						<TableScroll label={`${repo} 工厂记录`}>
							<Table className="giraffe-data-table factory-record-table min-w-[760px]">
								<TableHeader>
									<TableRow>
										{headers.map((column) => (
											<TableHead
												key={column.head || "link"}
												{...(column.head === "记录" ? { "data-grow": true } : {})}
												{...(column.headClassName ? { className: column.headClassName } : {})}
											>
												{column.head}
											</TableHead>
										))}
									</TableRow>
								</TableHeader>
								<TableBody>
									{items.map((event) => (
										<TableRow key={event.id}>
											{headers.map((column) => (
												<TableCell
													key={`${event.id}:${column.head || "link"}`}
													{...(column.className ? { className: column.className } : {})}
												>
													{column.cell(event)}
												</TableCell>
											))}
										</TableRow>
									))}
								</TableBody>
							</Table>
						</TableScroll>
					)}
				</LayerCard.Well>
			</LayerCard>
			{pages > 1 ? (
				<div className="flex items-center justify-end gap-2 text-xs text-basalt-muted-foreground">
					<span>
						第 {page}/{pages} 页 · 每页 {PAGE_SIZE} 条
					</span>
					<Button
						size="sm"
						variant="secondary"
						disabled={page <= 1}
						onClick={() => setPage(page - 1)}
					>
						上一页
					</Button>
					<Button
						size="sm"
						variant="secondary"
						disabled={page >= pages}
						onClick={() => setPage(page + 1)}
					>
						下一页
					</Button>
				</div>
			) : null}
		</div>
	);
}
