import { Badge } from "@nocoo/basalt";
import type { ComponentProps } from "react";
import { type CandyTone, candyClass } from "../../lib/format";

export function CandyBadge({
	tone,
	className,
	...props
}: { tone: CandyTone } & Omit<ComponentProps<typeof Badge>, "variant">) {
	return (
		<Badge
			variant={null}
			className={`${candyClass(tone)} shrink-0 whitespace-nowrap ${className ?? ""}`}
			{...props}
		/>
	);
}
