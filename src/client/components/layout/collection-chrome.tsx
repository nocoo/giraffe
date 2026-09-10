import { InputGroup } from "@nocoo/basalt/components/input-group";
import { ScrollArea } from "@nocoo/basalt/components/scroll-area";
import { Clock3, Search, X } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { formatCount, formatDate } from "../../lib/format";

// Product compositions: Basalt owns input behavior, focus styling and scrolling.
export function SearchField({
	value,
	onValueChange,
	label,
	placeholder = label,
}: {
	value: string;
	onValueChange: (value: string) => void;
	label: string;
	placeholder?: string;
}) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<InputGroup className="h-8 w-full sm:w-64">
			<InputGroup.Addon>
				<Search aria-hidden="true" />
			</InputGroup.Addon>
			<InputGroup.Input
				ref={input}
				type="search"
				value={value}
				onChange={(event) => onValueChange(event.target.value)}
				aria-label={label}
				placeholder={placeholder}
				className="[&::-webkit-search-cancel-button]:appearance-none"
			/>
			{value ? (
				<InputGroup.Button
					type="button"
					aria-label="清空搜索框"
					className="mr-0.5"
					onClick={() => {
						onValueChange("");
						input.current?.focus();
					}}
				>
					<X className="size-3.5" aria-hidden="true" />
				</InputGroup.Button>
			) : null}
		</InputGroup>
	);
}

export function ResultCount({ count, total = count }: { count: number; total?: number }) {
	return (
		<span
			className="whitespace-nowrap text-xs tabular-nums text-basalt-muted-foreground"
			role="status"
		>
			{count === total
				? `共 ${formatCount(total)} 项`
				: `${formatCount(count)} / ${formatCount(total)} 项`}
		</span>
	);
}

export function SnapshotDescription({
	description,
	fetchedAt,
}: {
	description: string;
	fetchedAt: string;
}) {
	return (
		<>
			<span className="[overflow-wrap:anywhere]">{description}</span>
			<span className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
				<Clock3 className="size-3.5 shrink-0" aria-hidden="true" />
				数据更新于{" "}
				<time dateTime={fetchedAt} className="tabular-nums">
					{formatDate(fetchedAt)}
				</time>
			</span>
		</>
	);
}

export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
	return (
		<ScrollArea
			orientation="horizontal"
			aria-label={label}
			className="w-full"
			viewportClassName="pb-1"
		>
			{children}
		</ScrollArea>
	);
}
