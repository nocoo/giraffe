import { LayerCard } from "@nocoo/basalt/components/layer-card";
import type { HTMLAttributes, JSX, ReactNode } from "react";

export function EmptyState({
	icon,
	title,
	description,
	action,
	children,
	className,
	...props
}: {
	icon?: ReactNode;
	title?: string;
	description?: string;
	action?: ReactNode;
	children?: ReactNode;
	className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "title" | "children">): JSX.Element {
	const emptyProps = {
		...(icon !== undefined ? { icon } : {}),
		...(title !== undefined ? { title } : {}),
		...(description !== undefined ? { description } : {}),
		...(action !== undefined ? { action } : {}),
		...(children !== undefined ? { children } : {}),
	};
	return (
		<LayerCard.Empty
			className={`h-full min-h-[var(--giraffe-empty-min-height,70vh)] justify-center${className ? ` ${className}` : ""}`}
			{...props}
			{...emptyProps}
		/>
	);
}
