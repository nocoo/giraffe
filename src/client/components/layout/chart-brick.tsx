import { LayerCard } from "@nocoo/basalt/components/layer-card";
import type { ReactNode } from "react";

export function ChartBrick({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: ReactNode;
}) {
	return (
		<LayerCard className="min-w-0">
			<LayerCard.Header>
				<div className="space-y-1">
					<h3 className="text-sm font-medium text-basalt-foreground">{title}</h3>
					{description ? <p className="text-xs">{description}</p> : null}
				</div>
			</LayerCard.Header>
			<LayerCard.Body>
				<div className="min-h-56 min-w-0">{children}</div>
			</LayerCard.Body>
		</LayerCard>
	);
}

export function ChartEmpty({ label }: { label: string }) {
	return (
		<div className="flex min-h-56 items-center justify-center">
			<p className="text-sm text-basalt-muted-foreground" role="status">
				{label}
			</p>
		</div>
	);
}

export function ChartRow({ children }: { children: ReactNode }) {
	return <div className="grid min-w-0 gap-3 lg:grid-cols-2">{children}</div>;
}
