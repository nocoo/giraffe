import { InputGroup } from "@nocoo/basalt/components/input-group";
import { ScrollArea } from "@nocoo/basalt/components/scroll-area";
import { Clock3, Search, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { SnapshotFreshness } from "../../../lib/snapshot-freshness";
import { formatCount, formatSnapshotFreshness } from "../../lib/format";

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
	freshness,
	hideTimestamp = false,
}: {
	description: string;
	fetchedAt: string | null | undefined;
	freshness?: SnapshotFreshness | undefined;
	hideTimestamp?: boolean;
}) {
	return (
		<span className="inline-flex w-full flex-wrap items-center gap-x-4 gap-y-1">
			<span className="[overflow-wrap:anywhere]">{description}</span>
			<span
				className={`inline-flex min-w-0${hideTimestamp ? " invisible" : ""}`}
				aria-hidden={hideTimestamp}
			>
				<SnapshotTime fetchedAt={fetchedAt} freshness={freshness} />
			</span>
		</span>
	);
}

export function SnapshotTime({
	fetchedAt,
	freshness,
	label = "数据更新",
}: {
	fetchedAt: string | null | undefined;
	freshness?: SnapshotFreshness | undefined;
	label?: string;
}) {
	const [, refreshTime] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => refreshTime((tick) => tick + 1), 60_000);
		return () => clearInterval(timer);
	}, []);
	const latest = freshness ? freshness.latestAt : fetchedAt;
	const mixed =
		freshness?.oldestAt && latest && Date.parse(freshness.oldestAt) < Date.parse(latest);
	const text = formatSnapshotFreshness(fetchedAt, freshness);
	return (
		<span className="text-xs text-basalt-muted-foreground">
			<span className="mr-1.5 inline-flex items-center gap-1.5 whitespace-nowrap align-middle">
				<Clock3 className="size-3.5 shrink-0" aria-hidden="true" />
				{label}
			</span>
			{latest && Number.isFinite(Date.parse(latest)) && !mixed && freshness?.total !== 0 ? (
				<time dateTime={latest} className="tabular-nums">
					{text}
				</time>
			) : (
				<span className="tabular-nums">{text}</span>
			)}
		</span>
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
