import { Button } from "@nocoo/basalt";
import { SlotBarChart } from "@nocoo/basalt/charts/slot-bar";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { takeChips } from "../../lib/format";
import { UserChip } from "../github-user";
import { CandyBadge } from "./candy-badge";

export function SortButton({
	label,
	active,
	onClick,
	direction = "desc",
}: {
	label: string;
	active: boolean;
	onClick: () => void;
	direction?: "asc" | "desc";
}) {
	const Icon = active ? (direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			className="-mx-2 h-7 gap-1.5 px-2"
			aria-pressed={active}
			onClick={onClick}
		>
			{label}
			<Icon
				className={`size-3.5 ${active ? "text-basalt-foreground" : "text-basalt-muted-foreground/40"}`}
				aria-hidden="true"
			/>
		</Button>
	);
}

export function PersonCell({ login }: { login: string | null }) {
	return <UserChip login={login} size="sm" className="max-w-40" />;
}

export function LabelChips({
	labels,
	wrap = true,
}: {
	labels: readonly (string | { name: string })[];
	wrap?: boolean;
}) {
	const names = labels.map((label) => (typeof label === "string" ? label : label.name));
	if (names.length === 0) {
		return <span className="text-basalt-muted-foreground">—</span>;
	}
	const { shown, extra } = takeChips(names, 2);
	return (
		<span className={`inline-flex items-center gap-1 ${wrap ? "flex-wrap" : "flex-nowrap"}`}>
			{shown.map((name) => (
				<CandyBadge
					tone="gray"
					key={name}
					className="max-w-44 truncate border-transparent px-2 py-0.5 text-xs"
					title={name}
					style={{
						color: "var(--color-basalt-foreground)",
						backgroundColor: `color-mix(in srgb, ${categoryColor(name)} 24%, var(--color-basalt-secondary))`,
					}}
				>
					{name}
				</CandyBadge>
			))}
			{extra > 0 ? (
				<CandyBadge tone="gray" title={names.join("、")}>
					+{extra}
				</CandyBadge>
			) : null}
		</span>
	);
}

export function Meter({ filled, tone, label }: { filled: number; tone: string; label: string }) {
	const items = Array.from({ length: 8 }, (_, index) => ({
		color: index < filled ? tone : "bg-basalt-muted",
		height: 1,
	}));
	return (
		<SlotBarChart items={items} ariaLabel={label} heightClass="h-5" className="w-16 shrink-0" />
	);
}

export function ChurnMeter({ adds, dels, label }: { adds: number; dels: number; label: string }) {
	if (adds + dels === 0) {
		return <span className="text-basalt-muted-foreground">—</span>;
	}
	const items = [
		...Array.from({ length: adds }, () => ({ color: "bg-basalt-chart-5", height: 1 })),
		...Array.from({ length: dels }, () => ({ color: "bg-basalt-chart-11", height: 1 })),
	];
	return (
		<SlotBarChart items={items} ariaLabel={label} heightClass="h-5" className="w-16 shrink-0" />
	);
}

import { categoryColor } from "../../lib/chart-theme";
