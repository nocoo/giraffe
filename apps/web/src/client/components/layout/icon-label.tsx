import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { HelpTooltip } from "./help-tooltip";

export function IconLabel({
	icon: Icon,
	children,
	className = "",
	iconClassName = "size-4",
	hint,
	hintLabel,
}: {
	icon: LucideIcon;
	children: ReactNode;
	className?: string;
	iconClassName?: string;
	hint?: ReactNode;
	hintLabel?: string;
}) {
	return (
		<span className={`inline-flex min-w-0 items-center gap-2 ${className}`}>
			<Icon className={`${iconClassName} shrink-0`} strokeWidth={1.5} aria-hidden="true" />
			<span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
			{hint ? (
				<HelpTooltip
					label={hintLabel ?? (typeof children === "string" ? `${children}说明` : "说明")}
				>
					{hint}
				</HelpTooltip>
			) : null}
		</span>
	);
}
