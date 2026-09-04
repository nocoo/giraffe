import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { SkeletonLine } from "@nocoo/basalt/components/skeleton-line";

function Shimmer({ delayMs = 0 }: { delayMs?: number }) {
	return (
		<span
			className="pointer-events-none absolute inset-0 animate-basalt-shimmer bg-gradient-to-r from-transparent via-black/10 to-transparent motion-reduce:animate-none"
			style={delayMs > 0 ? { animationDelay: `${delayMs}ms` } : undefined}
		/>
	);
}

export function SkeletonBlock({
	className = "",
	delayMs = 0,
}: {
	className?: string;
	delayMs?: number;
}) {
	return (
		<div
			className={`relative overflow-hidden rounded-md bg-basalt-muted ${className}`}
			aria-hidden="true"
		>
			<Shimmer delayMs={delayMs} />
		</div>
	);
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
		<LayerCard>
			<LayerCard.Well className="p-0">
				<div role="status" aria-label={label} className="flex flex-col gap-2 p-3">
					{Array.from({ length: rows }, (_, index) => (
						<SkeletonBlock
							key={`row-${index.toString()}`}
							className="h-10 w-full"
							delayMs={index * 45}
						/>
					))}
				</div>
			</LayerCard.Well>
		</LayerCard>
	);
}

export function DetailSkeleton({ label }: { label: string }) {
	return (
		<div className="flex flex-col gap-4" role="status" aria-label={label}>
			<div className="grid grid-cols-3 gap-3">
				{["sk-a", "sk-b", "sk-c"].map((id, index) => (
					<LayerCard key={id} padding="md">
						<SkeletonLine height={8} minWidth={24} maxWidth={40} />
						<SkeletonBlock className="mt-3 h-7 w-16" delayMs={index * 70} />
					</LayerCard>
				))}
			</div>
			<LayerCard>
				<LayerCard.Header>
					<SkeletonLine height={10} minWidth={22} maxWidth={36} />
				</LayerCard.Header>
				<LayerCard.Body className="space-y-3">
					<SkeletonLine minWidth={44} maxWidth={68} />
					<SkeletonLine minWidth={36} maxWidth={58} />
					<SkeletonBlock className="h-8 w-28" delayMs={140} />
				</LayerCard.Body>
			</LayerCard>
			<SkeletonBlock className="h-48 w-full rounded-lg" delayMs={180} />
		</div>
	);
}

export function ChartSkeleton({ label }: { label: string }) {
	return (
		<LayerCard>
			<LayerCard.Well>
				<div role="status" aria-label={label}>
					<SkeletonBlock className="h-52 w-full rounded-lg" />
				</div>
			</LayerCard.Well>
		</LayerCard>
	);
}

export function PeopleSkeleton({ label, rows = 6 }: { label: string; rows?: number }) {
	return (
		<LayerCard>
			<LayerCard.Well>
				<div role="status" aria-label={label} className="flex flex-col gap-3">
					{Array.from({ length: rows }, (_, index) => (
						<div key={`person-${index.toString()}`} className="flex items-center gap-3">
							<SkeletonBlock className="size-9 shrink-0 rounded-full" delayMs={index * 45} />
							<SkeletonLine minWidth={28} maxWidth={48} />
							<SkeletonBlock className="ml-auto h-4 w-10" delayMs={index * 45 + 20} />
						</div>
					))}
				</div>
			</LayerCard.Well>
		</LayerCard>
	);
}
