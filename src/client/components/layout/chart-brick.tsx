import { LayerCard } from "@nocoo/basalt/components/layer-card";
import type { ReactNode } from "react";

export function ChartBrick({ title, children }: { title: string; children: ReactNode }) {
	return (
		<LayerCard padding="md">
			<p className="mb-3 text-sm font-medium">{title}</p>
			<div className="h-52 min-w-0">{children}</div>
		</LayerCard>
	);
}

export function ChartEmpty({ label }: { label: string }) {
	return (
		<div className="flex h-full items-center justify-center">
			<p className="text-sm text-basalt-muted-foreground" role="status">
				{label}
			</p>
		</div>
	);
}

export function ChartRow({ children }: { children: ReactNode }) {
	return <div className="grid gap-3 lg:grid-cols-2">{children}</div>;
}
