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
		<LayerCard padding="md">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="text-xs text-basalt-muted-foreground">{label}</p>
					<p className="mt-1 tabular-nums text-xl font-medium tracking-tight">{value}</p>
				</div>
				<Icon className="size-4 shrink-0 text-basalt-primary" strokeWidth={1.5} />
			</div>
		</LayerCard>
	);
}

export function KpiRow({ children }: { children: ReactNode }) {
	return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}
