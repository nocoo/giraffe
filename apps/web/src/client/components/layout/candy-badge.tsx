import { Badge } from "@nocoo/basalt";
import type { LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { type CandyTone, candyClass } from "../../lib/format";

export function CandyBadge({
	tone,
	className,
	icon: Icon,
	children,
	...props
}: { tone: CandyTone; icon?: LucideIcon } & Omit<ComponentProps<typeof Badge>, "variant">) {
	return (
		<Badge
			variant={null}
			className={`${candyClass(tone)} shrink-0 gap-1.5 whitespace-nowrap ${className ?? ""}`}
			{...props}
		>
			{Icon ? <Icon className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" /> : null}
			{children}
		</Badge>
	);
}
