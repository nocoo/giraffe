import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { SkeletonLine } from "@nocoo/basalt/components/skeleton-line";

function Row({ columns, height }: { columns: number; height: number }) {
	return (
		<div className="flex items-center gap-4 px-4 py-3">
			{Array.from({ length: columns }, (_, index) => (
				<SkeletonLine
					key={`col-${index.toString()}`}
					className="min-w-0 flex-1"
					height={height}
					minWidth={18}
					maxWidth={index === 0 ? 70 : 40}
				/>
			))}
		</div>
	);
}

export function TableSkeleton({
	label,
	columns,
	rows = 8,
}: {
	label: string;
	columns: number;
	rows?: number;
}) {
	return (
		<LayerCard>
			<LayerCard.Well className="p-0">
				<div role="status" aria-label={label} className="divide-y divide-basalt-border">
					<Row columns={columns} height={10} />
					{Array.from({ length: rows }, (_, index) => (
						<Row key={`row-${index.toString()}`} columns={columns} height={12} />
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
				{["sk-a", "sk-b", "sk-c"].map((id) => (
					<LayerCard key={id} padding="md">
						<SkeletonLine height={10} minWidth={20} maxWidth={36} />
						<div className="mt-3">
							<SkeletonLine height={22} minWidth={28} maxWidth={48} />
						</div>
					</LayerCard>
				))}
			</div>
			<LayerCard>
				<LayerCard.Header>
					<SkeletonLine height={12} minWidth={24} maxWidth={40} />
				</LayerCard.Header>
				<LayerCard.Body className="space-y-3">
					<SkeletonLine height={12} minWidth={48} maxWidth={80} />
					<SkeletonLine height={12} minWidth={40} maxWidth={72} />
					<SkeletonLine height={12} minWidth={36} maxWidth={56} />
				</LayerCard.Body>
			</LayerCard>
		</div>
	);
}
