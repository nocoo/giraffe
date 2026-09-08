import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { SkeletonLine } from "@nocoo/basalt/components/skeleton-line";
import { type ReactNode, useEffect, useState } from "react";

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
	if (!show) {
		return null;
	}
	return children;
}

export function TableSkeleton({
	label,
	rows = 8,
}: {
	label: string;
	columns?: number;
	rows?: number;
}) {
	return (
		<Deferred>
			<LayerCard>
				<div role="status" aria-label={label} className="flex flex-col gap-3 p-4">
					{Array.from({ length: rows }, (_, index) => (
						<SkeletonLine
							key={`row-${index.toString()}`}
							minWidth={52 + (index % 4) * 8}
							maxWidth={88 + (index % 3) * 4}
							height={12}
						/>
					))}
				</div>
			</LayerCard>
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

export function InsightsSkeleton({ label }: { label: string }) {
	return (
		<Deferred>
			<div className="space-y-8" role="status" aria-label={label}>
				{["sk-work", "sk-review", "sk-health"].map((section) => (
					<div key={section} className="space-y-3">
						<SkeletonLine height={8} minWidth={18} maxWidth={28} />
						<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
							{["a", "b", "c", "d"].map((slot) => (
								<LayerCard key={`${section}-${slot}`} className="space-y-3" padding="md">
									<SkeletonLine height={8} minWidth={16} maxWidth={28} />
									<SkeletonLine height={22} minWidth={28} maxWidth={44} />
								</LayerCard>
							))}
						</div>
						<div className="grid gap-3 lg:grid-cols-2">
							<LayerCard className="space-y-3" padding="md">
								<SkeletonLine height={10} minWidth={22} maxWidth={36} />
								<div className="flex h-40 items-end gap-2">
									{CHART_BARS.map((height) => (
										<SkeletonLine
											key={`${section}-${height.toString()}`}
											minWidth={100}
											maxWidth={100}
											height={height}
											className="flex-1"
										/>
									))}
								</div>
							</LayerCard>
							<LayerCard className="space-y-3" padding="md">
								<SkeletonLine height={10} minWidth={22} maxWidth={36} />
								<div className="flex h-40 items-end gap-2">
									{CHART_BARS.map((height) => (
										<SkeletonLine
											key={`${section}-b-${height.toString()}`}
											minWidth={100}
											maxWidth={100}
											height={height}
											className="flex-1"
										/>
									))}
								</div>
							</LayerCard>
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
