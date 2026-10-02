import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { SkeletonLine } from "@nocoo/basalt/components/skeleton-line";
import { useEffect, useState } from "react";
import { type factoryBoard, formatFactoryCount as n } from "../viewmodels/factory";

type Activity = ReturnType<typeof factoryBoard>["activity"];
const BUCKETS = [
	["week", "7 日内有提交"],
	["month", "30 日内"],
	["dormant", "沉寂"],
	["unknown", "未采集"],
] as const;

/** Share of repositories by last-commit age; unmeasured repositories are never counted as dormant. */
export function ActivityBar({ activity }: { activity: Activity }) {
	return (
		<div className="factory-activity">
			<div
				className="factory-activity-bar"
				role="img"
				aria-label={BUCKETS.map(([k, label]) => `${label} ${activity[k]}`).join("，")}
			>
				{BUCKETS.map(([k, label]) =>
					activity[k] ? (
						<span
							key={k}
							data-bucket={k}
							style={{ flexGrow: activity[k] }}
							title={`${label} ${activity[k]}`}
						/>
					) : null,
				)}
			</div>
			<dl className="factory-activity-legend">
				{BUCKETS.map(([k, label]) => (
					<div key={k} data-bucket={k}>
						<dt>{label}</dt>
						<dd>{n(activity[k])}</dd>
					</div>
				))}
			</dl>
		</div>
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
			<LayerCard padding="md" className="grid grid-cols-2 gap-4 lg:grid-cols-5">
				{["a", "b", "c", "d", "e"].map((id) => (
					<div key={id} className="space-y-3">
						<SkeletonLine height={10} minWidth={40} maxWidth={60} />
						<SkeletonLine height={26} minWidth={44} maxWidth={56} />
						<SkeletonLine height={10} minWidth={60} maxWidth={80} />
					</div>
				))}
			</LayerCard>
			<div className="grid gap-3 xl:grid-cols-2">
				{["commits", "delivery", "prs", "issues"].map((id) => (
					<LayerCard key={id} padding="md" className="space-y-4">
						<SkeletonLine height={12} minWidth={20} maxWidth={28} />
						<SkeletonLine height={220} minWidth={100} maxWidth={100} />
					</LayerCard>
				))}
			</div>
		</div>
	);
}
