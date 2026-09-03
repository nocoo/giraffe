import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { SkeletonLine } from "@nocoo/basalt/components/skeleton-line";

const ROWS = ["sk-a", "sk-b", "sk-c", "sk-d", "sk-e", "sk-f"] as const;

export function PageSkeleton({ label }: { label: string }) {
	return (
		<LayerCard>
			<LayerCard.Header>
				<SkeletonLine minWidth={24} maxWidth={40} height={14} />
			</LayerCard.Header>
			<LayerCard.Primary>
				<div role="status" aria-label={label} className="space-y-3">
					{ROWS.map((id) => (
						<SkeletonLine key={id} minWidth={64} maxWidth={100} height={12} />
					))}
				</div>
			</LayerCard.Primary>
		</LayerCard>
	);
}
