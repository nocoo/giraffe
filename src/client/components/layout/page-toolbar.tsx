import { Text } from "@nocoo/basalt";
import type { ReactNode } from "react";

export const INLINE_SEGMENT = "[&>legend]:sr-only [&_[data-slot=segment-control-viewport]]:pb-0";

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
		<div className="flex items-center justify-between gap-4">
			<div className="flex min-w-0 items-center gap-3">
				<Text variant="heading" as="h1" size="lg" bold truncate>
					{title}
				</Text>
				{description ? (
					<Text as="p" size="sm" tone="muted" truncate>
						{description}
					</Text>
				) : null}
			</div>
			{actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
		</div>
	);
}
