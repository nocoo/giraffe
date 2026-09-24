import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { SkeletonLine } from "@nocoo/basalt/components/skeleton-line";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

const CHART_BARS = [32, 48, 40, 67, 55, 84, 69, 78] as const;

function useDeferredReveal(delayMs = 200): boolean {
	const [show, setShow] = useState(false);
	useEffect(() => {
		const id = window.setTimeout(() => setShow(true), delayMs);
		return () => window.clearTimeout(id);
	}, [delayMs]);
	return show;
}

function Deferred({ children }: { children: ReactNode }) {
	const show = useDeferredReveal();
	return <div className={show ? undefined : "invisible"}>{children}</div>;
}

function range(count: number, prefix: string) {
	return Array.from({ length: count }, (_, i) => `${prefix}-${i.toString()}`);
}

/** Header row plus two-line records: a wide identity column and narrow value columns. */
function TableRows({ columns, rows }: { columns: number; rows: number }) {
	const narrow = range(Math.max(0, columns - 1), "col");
	return (
		<LayerCard>
			<div className="giraffe-skeleton-row border-b border-basalt-border">
				<div>
					<SkeletonLine height={10} minWidth={100} maxWidth={100} style={{ width: 96 }} />
				</div>
				{narrow.map((id) => (
					<SkeletonLine key={id} height={10} minWidth={60} maxWidth={70} style={{ width: 64 }} />
				))}
			</div>
			{range(rows, "row").map((id, index) => (
				<div key={id} className="giraffe-skeleton-row">
					<div className="flex min-w-0 items-center gap-2.5">
						<SkeletonLine
							height={32}
							minWidth={100}
							maxWidth={100}
							className="shrink-0 rounded-md"
							style={{ width: 32 }}
						/>
						<div className="min-w-0 flex-1 space-y-2">
							<SkeletonLine
								height={12}
								minWidth={30 + (index % 3) * 10}
								maxWidth={44 + (index % 3) * 10}
							/>
							<SkeletonLine
								height={10}
								minWidth={50 + (index % 4) * 6}
								maxWidth={70 + (index % 4) * 6}
							/>
						</div>
					</div>
					{narrow.map((col) => (
						<SkeletonLine key={col} height={12} minWidth={50} maxWidth={80} style={{ width: 64 }} />
					))}
				</div>
			))}
		</LayerCard>
	);
}

export function TableSkeleton({
	label,
	columns = 4,
	rows = 8,
}: {
	label: string;
	columns?: number;
	rows?: number;
}) {
	return (
		<Deferred>
			<div role="status" aria-label={label}>
				<TableRows columns={Math.min(columns, 6)} rows={rows} />
			</div>
		</Deferred>
	);
}

function OverviewCardSkeleton({ kind, id }: { kind: "bars" | "rank" | "columns"; id: string }) {
	return (
		<LayerCard className="min-w-0">
			<div className="border-b border-basalt-border px-4 py-3">
				<SkeletonLine height={12} minWidth={24} maxWidth={36} />
			</div>
			<div className="p-4">
				{kind === "columns" ? (
					<div className="flex h-40 items-end gap-2">
						{CHART_BARS.slice(0, 5).map((height) => (
							<SkeletonLine
								key={`${id}-${height.toString()}`}
								minWidth={100}
								maxWidth={100}
								height={height * 1.6}
								className="flex-1"
							/>
						))}
					</div>
				) : kind === "bars" ? (
					<div className="flex h-40 items-end gap-1">
						{[...CHART_BARS, ...CHART_BARS].map((height, i) => (
							<SkeletonLine
								key={`${id}-${i.toString()}`}
								minWidth={100}
								maxWidth={100}
								height={height * 1.4}
								className="flex-1"
							/>
						))}
					</div>
				) : (
					<div className="flex h-40 flex-col justify-between">
						{range(6, id).map((row, i) => (
							<div key={row} className="grid grid-cols-[5rem_1fr_2rem] items-center gap-3">
								<SkeletonLine height={10} minWidth={60} maxWidth={90} />
								<SkeletonLine height={8} minWidth={90 - i * 12} maxWidth={90 - i * 12} />
								<SkeletonLine height={10} minWidth={100} maxWidth={100} />
							</div>
						))}
					</div>
				)}
			</div>
		</LayerCard>
	);
}

/**
 * Mirrors list pages: summary line, overview cards, the section rule and table records,
 * so data replaces placeholders in place instead of pushing content down.
 */
export function ListPageSkeleton({
	label,
	cards = ["columns", "rank", "bars"],
	columns = 5,
	rows = 8,
}: {
	label: string;
	cards?: ("bars" | "rank" | "columns")[];
	columns?: number;
	rows?: number;
}) {
	return (
		<Deferred>
			<div role="status" aria-label={label} className="space-y-6">
				<div className="flex flex-wrap gap-5">
					{range(4, "stat").map((id, i) => (
						<SkeletonLine
							key={id}
							height={12}
							minWidth={100}
							maxWidth={100}
							style={{ width: i ? 96 : 144 }}
						/>
					))}
				</div>
				{cards.length ? (
					<div className="giraffe-overview" style={{ "--cols": cards.length } as CSSProperties}>
						{cards.map((kind, i) => (
							<OverviewCardSkeleton
								key={`card-${i.toString()}`}
								kind={kind}
								id={`card-${i.toString()}`}
							/>
						))}
					</div>
				) : null}
				<div className="flex items-center gap-3">
					<SkeletonLine height={10} minWidth={100} maxWidth={100} style={{ width: 80 }} />
					<div className="h-px flex-1 border-t border-dashed border-basalt-border" />
					<SkeletonLine height={10} minWidth={100} maxWidth={100} style={{ width: 56 }} />
				</div>
				<TableRows columns={columns} rows={rows} />
			</div>
		</Deferred>
	);
}

export function DetailSkeleton({ label }: { label: string }) {
	return (
		<Deferred>
			<div className="flex flex-col gap-4" role="status" aria-label={label}>
				<div className="grid grid-cols-3 gap-3">
					{["sk-a", "sk-b", "sk-c"].map((id) => (
						<LayerCard key={id} className="space-y-3" padding="md">
							<SkeletonLine height={8} minWidth={24} maxWidth={40} />
							<SkeletonLine height={22} minWidth={36} maxWidth={52} />
						</LayerCard>
					))}
				</div>
				<LayerCard className="space-y-3" padding="md">
					<SkeletonLine minWidth={44} maxWidth={68} />
					<SkeletonLine minWidth={36} maxWidth={58} />
					<SkeletonLine minWidth={28} maxWidth={40} height={12} />
				</LayerCard>
			</div>
		</Deferred>
	);
}

function ChartCardSkeleton({ id, donut = false }: { id: string; donut?: boolean }) {
	return (
		<LayerCard className="min-w-0">
			<div className="border-b border-basalt-border px-4 py-3">
				<SkeletonLine height={12} minWidth={22} maxWidth={32} />
			</div>
			<div className="flex h-64 items-end gap-2 p-4">
				{donut ? (
					<div className="flex h-full w-full items-center justify-center">
						<div className="size-36 rounded-full border-[22px] border-basalt-muted" />
					</div>
				) : (
					CHART_BARS.map((height) => (
						<SkeletonLine
							key={`${id}-${height.toString()}`}
							minWidth={100}
							maxWidth={100}
							height={height * 2}
							className="flex-1"
						/>
					))
				)}
			</div>
		</LayerCard>
	);
}

/** Top 10 focus list with findings, then the three chart sections. */
export function InsightsSkeleton({ label }: { label: string }) {
	return (
		<Deferred>
			<div className="space-y-8" role="status" aria-label={label}>
				<div className="space-y-3">
					<SkeletonLine height={10} minWidth={14} maxWidth={20} />
					<div className="giraffe-focus">
						<LayerCard>
							{range(5, "focus").map((id, i) => (
								<div
									key={id}
									className="grid grid-cols-[2rem_1fr_auto] gap-3 border-b border-basalt-border px-4 py-3 last:border-0"
								>
									<SkeletonLine
										height={28}
										minWidth={100}
										maxWidth={100}
										className="rounded-full"
										style={{ width: 28 }}
									/>
									<div className="space-y-2">
										<SkeletonLine
											height={14}
											minWidth={24 + (i % 3) * 6}
											maxWidth={32 + (i % 3) * 6}
										/>
										<SkeletonLine height={10} minWidth={44} maxWidth={60} />
										<SkeletonLine height={10} minWidth={30} maxWidth={46} />
									</div>
									<SkeletonLine
										height={28}
										minWidth={100}
										maxWidth={100}
										className="hidden lg:block"
										style={{ width: 256 }}
									/>
								</div>
							))}
						</LayerCard>
						<LayerCard padding="md" className="space-y-3">
							<SkeletonLine height={12} minWidth={24} maxWidth={32} />
							{range(4, "finding").map((id, i) => (
								<SkeletonLine
									key={id}
									height={10}
									minWidth={70 + (i % 2) * 20}
									maxWidth={80 + (i % 2) * 20}
								/>
							))}
						</LayerCard>
					</div>
				</div>
				{["work", "review"].map((section) => (
					<div key={section} className="space-y-3">
						<SkeletonLine height={10} minWidth={10} maxWidth={14} />
						<SkeletonLine height={10} minWidth={30} maxWidth={40} />
						<div className="grid gap-3 lg:grid-cols-2">
							<ChartCardSkeleton id={`${section}-a`} />
							<ChartCardSkeleton id={`${section}-b`} donut />
						</div>
					</div>
				))}
			</div>
		</Deferred>
	);
}

export function ChartSkeleton({ label }: { label: string }) {
	return (
		<Deferred>
			<LayerCard padding="md">
				<div role="status" aria-label={label} className="space-y-3">
					<SkeletonLine height={10} minWidth={22} maxWidth={36} />
					<div className="flex h-40 items-end gap-2">
						{CHART_BARS.map((height) => (
							<SkeletonLine
								key={height}
								minWidth={100}
								maxWidth={100}
								height={height}
								className="flex-1"
							/>
						))}
					</div>
				</div>
			</LayerCard>
		</Deferred>
	);
}

export function PeopleSkeleton({ label, rows = 6 }: { label: string; rows?: number }) {
	return (
		<Deferred>
			<LayerCard padding="md">
				<div role="status" aria-label={label} className="flex flex-col gap-4">
					{Array.from({ length: rows }, (_, index) => (
						<div key={`person-${index.toString()}`} className="flex items-center gap-3">
							<SkeletonLine
								minWidth={100}
								maxWidth={100}
								height={36}
								className="rounded-full"
								style={{ width: 36, flexShrink: 0 }}
							/>
							<div className="min-w-0 flex-1">
								<SkeletonLine minWidth={28} maxWidth={48} />
							</div>
							<SkeletonLine minWidth={12} maxWidth={18} height={10} />
						</div>
					))}
				</div>
			</LayerCard>
		</Deferred>
	);
}

/** CI: verdict strip with four tiles, the broken-workflow card grid, then watch lists and the chart. */
export function CiSkeleton({ label }: { label: string }) {
	return (
		<Deferred>
			<div role="status" aria-label={label} className="space-y-6">
				<LayerCard padding="md" className="space-y-4">
					<SkeletonLine height={8} minWidth={100} maxWidth={100} className="rounded-full" />
					<div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
						{range(4, "tile").map((id) => (
							<div key={id} className="space-y-2 border-l-2 border-basalt-border pl-3">
								<SkeletonLine height={10} minWidth={40} maxWidth={50} />
								<SkeletonLine height={24} minWidth={20} maxWidth={24} />
								<SkeletonLine height={10} minWidth={60} maxWidth={70} />
							</div>
						))}
					</div>
				</LayerCard>
				<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
					{range(3, "broken").map((id) => (
						<LayerCard key={id} padding="md" className="space-y-3 border-l-2 border-basalt-border">
							<SkeletonLine height={14} minWidth={50} maxWidth={60} />
							<SkeletonLine height={10} minWidth={30} maxWidth={36} />
							<SkeletonLine height={20} minWidth={40} maxWidth={44} />
							<SkeletonLine height={10} minWidth={60} maxWidth={70} />
						</LayerCard>
					))}
				</div>
				<div className="giraffe-overview" style={{ "--cols": 2 } as CSSProperties}>
					<OverviewCardSkeleton kind="rank" id="watch" />
					<OverviewCardSkeleton kind="bars" id="daily" />
				</div>
			</div>
		</Deferred>
	);
}

/** Repository first load: tab strip, five KPI cards, the 90-day activity chart and release line. */
export function RepoDetailSkeleton({ label }: { label: string }) {
	return (
		<Deferred>
			<div role="status" aria-label={label} className="space-y-4">
				<div className="flex gap-6 border-b border-basalt-border pb-3">
					{range(10, "tab").map((id) => (
						<SkeletonLine
							key={id}
							height={12}
							minWidth={100}
							maxWidth={100}
							style={{ width: 52 }}
						/>
					))}
				</div>
				<div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
					{range(5, "kpi").map((id) => (
						<LayerCard key={id} padding="md" className="space-y-3">
							<SkeletonLine height={10} minWidth={36} maxWidth={44} />
							<SkeletonLine height={24} minWidth={24} maxWidth={32} />
							<SkeletonLine height={10} minWidth={56} maxWidth={70} />
						</LayerCard>
					))}
				</div>
				<ChartCardSkeleton id="activity" />
				<LayerCard padding="md" className="space-y-3">
					<SkeletonLine height={12} minWidth={14} maxWidth={18} />
					<SkeletonLine height={4} minWidth={100} maxWidth={100} />
				</LayerCard>
			</div>
		</Deferred>
	);
}
