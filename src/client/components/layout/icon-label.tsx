import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function IconLabel({
	icon: Icon,
	children,
	className = "",
}: {
	icon: LucideIcon;
	children: ReactNode;
	className?: string;
}) {
	return (
		<span className={`inline-flex min-w-0 items-center gap-2 ${className}`}>
			<Icon className="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
			<span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
		</span>
	);
}
