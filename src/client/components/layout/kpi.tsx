import { LayerCard } from "@nocoo/basalt/components/layer-card";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function Kpi({
	icon: Icon,
	label,
	value,
}: {
	icon: LucideIcon;
	label: string;
	value: string;
}) {
	return (
		<LayerCard padding="md" className="min-w-0">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="text-xs text-basalt-muted-foreground">{label}</p>
					<p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
				</div>
				<Icon
					className="mt-0.5 size-4 shrink-0 text-basalt-primary"
					strokeWidth={1.5}
					aria-hidden="true"
				/>
			</div>
		</LayerCard>
	);
}

export function KpiRow({ children }: { children: ReactNode }) {
	return (
		<div className="grid grid-cols-2 gap-3 max-sm:[&>:last-child:nth-child(odd)]:col-span-2 sm:auto-cols-fr sm:grid-flow-col sm:grid-cols-none">
			{children}
		</div>
	);
}
