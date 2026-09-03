import { Text } from "@nocoo/basalt";
import type { ReactNode } from "react";

export function PageToolbar({
	title,
	description,
	actions,
}: {
	title: string;
	description?: string | undefined;
	actions?: ReactNode | undefined;
}) {
	return (
		<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
			<div className="min-w-0 space-y-0.5">
				<Text variant="heading" as="h1" size="lg" bold truncate>
					{title}
				</Text>
				{description ? (
					<Text as="p" size="sm" tone="muted">
						{description}
					</Text>
				) : null}
			</div>
			{actions ? (
				<div className="flex flex-wrap items-center gap-2 md:justify-end">{actions}</div>
			) : null}
		</div>
	);
}
