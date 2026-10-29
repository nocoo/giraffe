import { Button } from "@nocoo/basalt";
import {
	Popover,
	PopoverContent,
	PopoverTitle,
	PopoverTrigger,
} from "@nocoo/basalt/components/popover";
import { ChevronDown, Clock3 } from "lucide-react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useId,
	useMemo,
	useState,
} from "react";
import { DISPLAY_TIMEZONE, formatPreciseDate } from "../../lib/format";
import { type DataTime, dataTimeSummary } from "../../viewmodels/data-time";

type Registry = Map<string, DataTime[]>;
const DataTimeContext = createContext<{
	sources: Registry;
	setSources: (update: (sources: Registry) => Registry) => void;
} | null>(null);

export function DataTimeProvider({ children, scope }: { children: ReactNode; scope: string }) {
	const [registry, setRegistry] = useState({ scope, sources: new Map<string, DataTime[]>() });
	if (registry.scope !== scope) setRegistry({ scope, sources: new Map() });
	const setSources = useCallback(
		(update: (sources: Registry) => Registry) => {
			setRegistry((current) =>
				current.scope === scope ? { scope, sources: update(current.sources) } : current,
			);
		},
		[scope],
	);
	const value = useMemo(
		() => ({ sources: registry.sources, setSources }),
		[registry.sources, setSources],
	);
	return <DataTimeContext value={value}>{children}</DataTimeContext>;
}

export function DataTimeSource({ entries }: { entries: DataTime[] }) {
	const context = useContext(DataTimeContext);
	const setSources = context?.setSources;
	const id = useId();
	const serialized = JSON.stringify(entries);
	useEffect(() => {
		setSources?.((old) => new Map(old).set(id, JSON.parse(serialized) as DataTime[]));
		return () => {
			setSources?.((old) => {
				const next = new Map(old);
				next.delete(id);
				return next;
			});
		};
	}, [id, serialized, setSources]);
	return null;
}

export function DataTimeControl() {
	const context = useContext(DataTimeContext);
	const [now, setNow] = useState(Date.now);
	const titleId = useId();
	const entries = [...(context?.sources.values() ?? [])].flat();
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 60_000);
		return () => clearInterval(timer);
	}, []);
	const summary = dataTimeSummary(entries, now);
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="shrink-0 whitespace-nowrap tabular-nums"
					aria-label={`数据更新时间：${summary.label}`}
				>
					<Clock3 className="size-4" aria-hidden="true" />
					<span className="hidden sm:inline">{summary.label}</span>
					<ChevronDown className="size-3" aria-hidden="true" />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				aria-labelledby={titleId}
				className="w-96 max-w-[calc(100vw-2rem)] space-y-3"
			>
				<PopoverTitle id={titleId}>数据更新时间</PopoverTitle>
				<p className="text-sm font-medium tabular-nums">
					最近更新：{formatPreciseDate(summary.latestAt)}
				</p>
				<p className="text-xs text-basalt-muted-foreground">
					当前页面已保存快照的数据时间，不代表所有数据都已更新。
				</p>
				{summary.mixed ? (
					<p className="text-sm" role="note">
						部分数据仍来自较早的刷新，请查看各项时间。
					</p>
				) : null}
				{summary.incomplete ? (
					<p className="text-sm" role="note">
						部分来源尚未采集或缺少数据。
					</p>
				) : null}
				<dl className="max-h-80 space-y-3 overflow-y-auto">
					{summary.rows.map((row) => (
						<div key={row.label} className="space-y-1 text-xs">
							<dt className="font-medium">{row.label}</dt>
							<dd className="tabular-nums text-basalt-muted-foreground">
								{row.empty ? (
									"当前范围暂无数据"
								) : row.at ? (
									<time dateTime={row.at}>{formatPreciseDate(row.at)}</time>
								) : (
									"尚未采集"
								)}
								{row.oldestAt && row.oldestAt !== row.at ? (
									<span className="block">较早数据：{formatPreciseDate(row.oldestAt)}</span>
								) : null}
								{row.missing ? <span className="block">{row.missing} 项缺少数据</span> : null}
							</dd>
						</div>
					))}
				</dl>
				<p className="text-xs text-basalt-muted-foreground">显示时区：{DISPLAY_TIMEZONE}</p>
			</PopoverContent>
		</Popover>
	);
}
