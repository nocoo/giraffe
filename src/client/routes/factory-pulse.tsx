import { Button } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { SkeletonLine } from "@nocoo/basalt/components/skeleton-line";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import { LanguageLabel } from "../components/layout/labels";
import { type factoryBoard, formatFactoryCount as n } from "../viewmodels/factory";
import { FactoryPanel } from "./factory-charts";

type Pulse = ReturnType<typeof factoryBoard>["pulse"];

export function PulseDelta({ recent, previous }: { recent: number; previous: number }) {
	if (!previous) return <span className="factory-delta">前 7 日无提交</span>;
	const change = (recent - previous) / previous;
	const up = change >= 0;
	const Icon = up ? ArrowUpRight : ArrowDownRight;
	return (
		<span className="factory-delta" data-direction={up ? "up" : "down"}>
			<Icon className="size-3.5" aria-hidden="true" />
			{`${up ? "+" : ""}${Math.round(change * 100)}%`}
			<span className="text-basalt-muted-foreground">较前 7 日</span>
		</span>
	);
}

export function FactoryPulse({
	pulse,
	repos,
	onSelect,
}: {
	pulse: Pulse;
	repos: number;
	onSelect: (repo: string) => void;
}) {
	const max = Math.max(1, ...pulse.movers.map((m) => m.recent));
	const measured = repos - pulse.active.unknown;
	const buckets = [
		{ key: "week", label: "7 日内有提交", value: pulse.active.week },
		{ key: "month", label: "30 日内", value: pulse.active.month },
		{ key: "dormant", label: "沉寂", value: pulse.active.dormant },
		{ key: "unknown", label: "未采集", value: pulse.active.unknown },
	] as const;
	return (
		<FactoryPanel
			title="本周脉搏"
			hint={`最近 7 个完整 UTC 日（${pulse.range.since} 至 ${pulse.range.until}）的提交排行，与再往前 7 日对比。活跃度按每个仓库最后一次默认分支提交计算；未采集提交的仓库单列，不计为沉寂。`}
		>
			<div className="factory-pulse">
				<div className="factory-pulse-activity">
					<div
						className="factory-activity-bar"
						role="img"
						aria-label={buckets.map((b) => `${b.label} ${b.value}`).join("，")}
					>
						{buckets.map((b) =>
							b.value ? (
								<span
									key={b.key}
									data-bucket={b.key}
									style={{ flexGrow: b.value }}
									title={`${b.label} ${b.value}`}
								/>
							) : null,
						)}
					</div>
					<dl className="factory-activity-legend">
						{buckets.map((b) => (
							<div key={b.key} data-bucket={b.key}>
								<dt>{b.label}</dt>
								<dd>{n(b.value)}</dd>
							</div>
						))}
					</dl>
					<p className="text-xs text-basalt-muted-foreground">
						{measured
							? `${Math.round((pulse.active.week / measured) * 100)}% 的已采集仓库本周有推进`
							: "尚无已采集提交的仓库"}
					</p>
				</div>
				<div className="factory-pulse-movers">
					<h3>本周推进最多</h3>
					{pulse.movers.length ? (
						<ol>
							{pulse.movers.map((m, i) => (
								<li key={m.name} style={{ "--i": i } as React.CSSProperties}>
									<Button
										variant="ghost"
										type="button"
										className="factory-mover"
										onClick={() => onSelect(m.name)}
										aria-label={`${m.name}，本周 ${m.recent} 次提交，前 7 日 ${m.previous} 次，查看仓库`}
									>
										<span className="factory-mover-name">
											<strong>{m.name.split("/")[1]}</strong>
											<LanguageLabel name={m.language} />
										</span>
										<span className="factory-mover-track" aria-hidden="true">
											<span style={{ width: `${(m.recent / max) * 100}%` }} />
										</span>
										<span className="factory-mover-count">{n(m.recent)}</span>
									</Button>
								</li>
							))}
						</ol>
					) : (
						<p className="factory-chart-empty min-h-24">最近 7 日没有观测到提交。</p>
					)}
					{pulse.cooling.length ? (
						<p className="factory-cooling">
							<span>本周停滞</span>
							{pulse.cooling.map((m) => (
								<Button
									key={m.name}
									variant="ghost"
									type="button"
									className="factory-link"
									onClick={() => onSelect(m.name)}
									title={`前 7 日 ${m.previous} 次提交，本周 0 次`}
								>
									{m.name.split("/")[1]}
								</Button>
							))}
						</p>
					) : null}
				</div>
			</div>
		</FactoryPanel>
	);
}

/** Mirrors the populated layout so the page does not jump when the snapshot arrives. */
export function FactorySkeleton() {
	const [show, setShow] = useState(false);
	useEffect(() => {
		const id = window.setTimeout(() => setShow(true), 150);
		return () => window.clearTimeout(id);
	}, []);
	if (!show) return <div role="status" aria-label="正在读取工厂快照" />;
	return (
		<div role="status" aria-label="正在读取工厂快照" className="factory-skeleton space-y-4">
			<div className="flex gap-3">
				<SkeletonLine height={32} minWidth={12} maxWidth={14} />
				<SkeletonLine height={32} minWidth={12} maxWidth={14} />
				<SkeletonLine height={32} minWidth={18} maxWidth={20} />
			</div>
			<div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
				{["a", "b", "c", "d", "e"].map((id) => (
					<LayerCard key={id} padding="md" className="space-y-3">
						<SkeletonLine height={10} minWidth={40} maxWidth={60} />
						<SkeletonLine height={26} minWidth={44} maxWidth={56} />
						<SkeletonLine height={28} minWidth={90} maxWidth={100} />
					</LayerCard>
				))}
			</div>
			<div className="grid gap-3 xl:grid-cols-[1.15fr_1fr]">
				{["calendar", "throughput"].map((id) => (
					<LayerCard key={id} padding="md" className="space-y-4">
						<SkeletonLine height={12} minWidth={20} maxWidth={28} />
						<SkeletonLine height={220} minWidth={100} maxWidth={100} />
					</LayerCard>
				))}
			</div>
		</div>
	);
}
