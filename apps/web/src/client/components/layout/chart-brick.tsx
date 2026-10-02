import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { Text } from "@nocoo/basalt/components/text";
import { ChartNoAxesCombined } from "lucide-react";
import type { ReactNode } from "react";
import { HelpTooltip } from "./help-tooltip";
import { IconLabel } from "./icon-label";

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
				<div className="flex items-center gap-2">
					<Text as="h3" variant="heading">
						<IconLabel icon={ChartNoAxesCombined}>{title}</IconLabel>
					</Text>
					{description ? <HelpTooltip label={`${title}说明`}>{description}</HelpTooltip> : null}
				</div>
			</LayerCard.Header>
			<LayerCard.Body className="flex flex-1 flex-col">{children}</LayerCard.Body>
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
