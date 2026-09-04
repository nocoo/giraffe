import { Avatar, AvatarFallback, Badge, Button } from "@nocoo/basalt";
import { SlotBarChart } from "@nocoo/basalt/charts/slot-bar";
import { ChevronDown } from "lucide-react";
import { fillTextColor, initials, labelFill, takeChips } from "../../lib/format";

export function SortButton({
	label,
	active,
	onClick,
}: {
	label: string;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<Button type="button" variant="ghost" size="sm" onClick={onClick}>
			{label}
			<ChevronDown
				className={`size-3.5 ${active ? "text-basalt-foreground" : "text-basalt-muted-foreground/40"}`}
			/>
		</Button>
	);
}

export function PersonCell({ login }: { login: string | null }) {
	if (!login) {
		return <span className="text-basalt-muted-foreground">—</span>;
	}
	return (
		<span className="inline-flex items-center gap-2">
			<Avatar className="size-6">
				<AvatarFallback className="text-[10px]">{initials(login)}</AvatarFallback>
			</Avatar>
			<span className="truncate">{login}</span>
		</span>
	);
}

export function LabelChips({ labels }: { labels: { name: string; color: string }[] }) {
	if (labels.length === 0) {
		return <span className="text-basalt-muted-foreground">—</span>;
	}
	const { shown, extra } = takeChips(labels, 2);
	return (
		<span className="inline-flex flex-wrap items-center gap-1">
			{shown.map((label) => {
				const fill = labelFill(label.color);
				return (
					<span
						key={label.name}
						className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium"
						style={{ backgroundColor: fill, color: fillTextColor(label.color) }}
					>
						{label.name}
					</span>
				);
			})}
			{extra > 0 ? <Badge variant="secondary">+{extra}</Badge> : null}
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
		...Array.from({ length: adds }, () => ({ color: "bg-basalt-heatmap-green-3", height: 1 })),
		...Array.from({ length: dels }, () => ({ color: "bg-basalt-chart-10", height: 1 })),
	];
	return (
		<SlotBarChart items={items} ariaLabel={label} heightClass="h-5" className="w-16 shrink-0" />
	);
}
