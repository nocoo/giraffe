import { StatCard } from "@nocoo/basalt/components/stat-card";
import type { LucideIcon } from "@nocoo/basalt/icons";
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
	const Icon = icon;
	return (
		<StatCard
			className="giraffe-stat-card min-w-0"
			title={label}
			value={value}
			{...(subtitle ? { subtitle } : {})}
			{...(Icon ? { icon: <Icon /> } : {})}
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
