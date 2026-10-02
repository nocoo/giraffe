import { StatCard } from "@nocoo/basalt/charts/stat-card";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function Kpi({
	icon,
	label,
	value,
	subtitle,
	children,
}: {
	icon?: LucideIcon;
	label: string;
	value: string;
	subtitle?: string;
	children?: ReactNode;
}) {
	return (
		<StatCard
			className="giraffe-stat-card min-w-0"
			title={label}
			value={value}
			{...(subtitle ? { subtitle } : {})}
			{...(icon ? { icon } : {})}
			iconColor="text-basalt-primary"
		>
			{children}
		</StatCard>
	);
}

export function KpiRow({ children }: { children: ReactNode }) {
	return (
		<div className="grid grid-cols-2 gap-4 max-lg:[&>:last-child:nth-child(odd)]:col-span-2 lg:auto-cols-fr lg:grid-flow-col lg:grid-cols-none">
			{children}
		</div>
	);
}
