import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { Skeleton } from "@nocoo/basalt/components/skeleton";
import type { CSSProperties, ReactNode } from "react";

const CHART_BARS = [32, 48, 40, 67, 55, 84, 69, 78] as const;

export function Deferred({ children }: { children: ReactNode }) {
	return <>{children}</>;
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
					<Skeleton height={10} width={96} />
				</div>
				{narrow.map((id) => (
					<Skeleton key={id} height={10} width={64} />
				))}
			</div>
			{range(rows, "row").map((id, index) => (
				<div key={id} className="giraffe-skeleton-row">
					<div className="flex min-w-0 items-center gap-2.5">
						<Skeleton height={32} width={32} className="shrink-0 rounded-md" />
						<div className="min-w-0 flex-1 space-y-2">
							<Skeleton height={12} width={`${37 + (index % 3) * 10}%`} />
							<Skeleton height={10} width={`${60 + (index % 4) * 6}%`} />
						</div>
					</div>
					{narrow.map((col) => (
						<Skeleton key={col} height={12} width={64} />
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
				<Skeleton height={12} width="30%" />
			</div>
			<div className="p-4">
				{kind === "columns" ? (
					<div className="flex h-40 items-end gap-2">
						{CHART_BARS.slice(0, 5).map((height) => (
							<Skeleton
								key={`${id}-${height.toString()}`}
								height={height * 1.6}
								className="flex-1"
							/>
						))}
					</div>
				) : kind === "bars" ? (
					<div className="flex h-40 items-end gap-1">
						{[...CHART_BARS, ...CHART_BARS].map((height, i) => (
							<Skeleton key={`${id}-${i.toString()}`} height={height * 1.4} className="flex-1" />
						))}
					</div>
				) : (
					<div className="flex h-40 flex-col justify-between">
						{range(6, id).map((row, i) => (
							<div key={row} className="grid grid-cols-[5rem_1fr_2rem] items-center gap-3">
								<Skeleton height={10} width="75%" />
								<Skeleton height={8} width={`${90 - i * 12}%`} />
								<Skeleton height={10} />
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
						<Skeleton key={id} height={12} width={i ? 96 : 144} />
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
					<Skeleton height={10} width={80} />
					<div className="h-px flex-1 border-t border-dashed border-basalt-border" />
					<Skeleton height={10} width={56} />
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
							<Skeleton height={8} width="32%" />
							<Skeleton height={22} width="44%" />
						</LayerCard>
					))}
				</div>
				<LayerCard className="space-y-3" padding="md">
					<Skeleton width="56%" />
					<Skeleton width="47%" />
					<Skeleton width="34%" height={12} />
				</LayerCard>
			</div>
		</Deferred>
	);
}

function ChartCardSkeleton({ id, donut = false }: { id: string; donut?: boolean }) {
	return (
		<LayerCard className="min-w-0">
			<div className="border-b border-basalt-border px-4 py-3">
				<Skeleton height={12} width="27%" />
			</div>
			<div className="flex h-64 items-end gap-2 p-4">
				{donut ? (
					<div className="flex h-full w-full items-center justify-center">
						<div className="size-36 rounded-full border-[22px] border-basalt-muted" />
					</div>
				) : (
					CHART_BARS.map((height) => (
						<Skeleton key={`${id}-${height.toString()}`} height={height * 2} className="flex-1" />
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
					<Skeleton height={10} width="17%" />
					<div className="giraffe-focus">
						<LayerCard>
							{range(5, "focus").map((id, i) => (
								<div
									key={id}
									className="grid grid-cols-[2rem_1fr_auto] gap-3 border-b border-basalt-border px-4 py-3 last:border-0"
								>
									<Skeleton variant="circle" height={28} width={28} />
									<div className="space-y-2">
										<Skeleton height={14} width={`${28 + (i % 3) * 6}%`} />
										<Skeleton height={10} width="52%" />
										<Skeleton height={10} width="38%" />
									</div>
									<Skeleton height={28} width={256} className="hidden lg:block" />
								</div>
							))}
						</LayerCard>
						<LayerCard padding="md" className="space-y-3">
							<Skeleton height={12} width="28%" />
							{range(4, "finding").map((id, i) => (
								<Skeleton key={id} height={10} width={`${75 + (i % 2) * 20}%`} />
							))}
						</LayerCard>
					</div>
				</div>
				{["work", "review"].map((section) => (
					<div key={section} className="space-y-3">
						<Skeleton height={10} width="12%" />
						<Skeleton height={10} width="35%" />
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
					<Skeleton height={10} width="29%" />
					<div className="flex h-40 items-end gap-2">
						{CHART_BARS.map((height) => (
							<Skeleton key={height} height={height} className="flex-1" />
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
							<Skeleton variant="circle" height={36} width={36} />
							<div className="min-w-0 flex-1">
								<Skeleton width="38%" />
							</div>
							<Skeleton width="15%" height={10} />
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
					<Skeleton height={8} className="rounded-full" />
					<div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
						{range(4, "tile").map((id) => (
							<div key={id} className="space-y-2 border-l-2 border-basalt-border pl-3">
								<Skeleton height={10} width="45%" />
								<Skeleton height={24} width="22%" />
								<Skeleton height={10} width="65%" />
							</div>
						))}
					</div>
				</LayerCard>
				<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
					{range(3, "broken").map((id) => (
						<LayerCard key={id} padding="md" className="space-y-3 border-l-2 border-basalt-border">
							<Skeleton height={14} width="55%" />
							<Skeleton height={10} width="33%" />
							<Skeleton height={20} width="42%" />
							<Skeleton height={10} width="65%" />
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
						<Skeleton key={id} height={12} width={52} />
					))}
				</div>
				<div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
					{range(5, "kpi").map((id) => (
						<LayerCard key={id} padding="md" className="space-y-3">
							<Skeleton height={10} width="40%" />
							<Skeleton height={24} width="28%" />
							<Skeleton height={10} width="63%" />
						</LayerCard>
					))}
				</div>
				<ChartCardSkeleton id="activity" />
				<LayerCard padding="md" className="space-y-3">
					<Skeleton height={12} width="16%" />
					<Skeleton height={4} />
				</LayerCard>
			</div>
		</Deferred>
	);
}

/** Today activity & compact repository activity skeleton matching window card, KPI strip and sections. */
export function ActivitySkeleton({ label, compact = false }: { label: string; compact?: boolean }) {
	return (
		<Deferred>
			<div role="status" aria-label={label} className="space-y-4">
				<LayerCard padding="md" className="space-y-3">
					<Skeleton height={12} width="22%" />
					<Skeleton height={16} width="48%" />
					<Skeleton height={10} width="34%" />
				</LayerCard>
				<div
					className={
						compact
							? "grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"
							: "grid grid-cols-2 gap-3 lg:grid-cols-4"
					}
				>
					{range(compact ? 6 : 4, "act-kpi").map((id) => (
						<LayerCard key={id} padding="md" className="space-y-2.5">
							<Skeleton height={10} width="49%" />
							<Skeleton height={24} width="29%" />
						</LayerCard>
					))}
				</div>
				<div
					className={
						compact ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-3" : "grid gap-4 xl:grid-cols-2"
					}
				>
					{range(compact ? 6 : 4, "act-sec").map((id) => (
						<LayerCard key={id} padding="md" className="space-y-3">
							<Skeleton height={12} width="30%" />
							<Skeleton height={12} width="75%" />
							<Skeleton height={12} width="60%" />
						</LayerCard>
					))}
				</div>
			</div>
		</Deferred>
	);
}

/** Refresh center skeleton matching summary strip, request breakdown and repository rows. */
export function RefreshSkeleton({ label }: { label: string }) {
	return (
		<Deferred>
			<div role="status" aria-label={label} className="space-y-4">
				<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
					{range(4, "ref-kpi").map((id) => (
						<LayerCard key={id} padding="md" className="space-y-2.5">
							<Skeleton height={10} width="47%" />
							<Skeleton height={22} width="32%" />
						</LayerCard>
					))}
				</div>
				<TableRows columns={4} rows={5} />
			</div>
		</Deferred>
	);
}

/** Compact identity row skeleton matching the h-10 avatar + name/email block on Settings. */
export function IdentitySkeleton() {
	return (
		<div role="status" aria-label="加载身份" className="flex items-center gap-3">
			<Skeleton variant="circle" height={40} width={40} />
			<div className="min-w-0 flex-1 space-y-2">
				<Skeleton height={14} width="30%" />
				<Skeleton height={12} width="48%" />
			</div>
		</div>
	);
}

/** Route-level Suspense fallback skeleton preventing text flash during lazy chunk load. */
export function RouteSkeleton({ label = "加载页面" }: { label?: string }) {
	return (
		<Deferred>
			<div role="status" aria-label={label} className="space-y-4 p-1">
				<div className="space-y-2">
					<Skeleton height={22} width="22%" />
					<Skeleton height={12} width="38%" />
				</div>
				<div className="grid gap-3 md:grid-cols-3">
					<OverviewCardSkeleton kind="bars" id="route-a" />
					<OverviewCardSkeleton kind="rank" id="route-b" />
					<OverviewCardSkeleton kind="columns" id="route-c" />
				</div>
				<TableRows columns={4} rows={5} />
			</div>
		</Deferred>
	);
}
