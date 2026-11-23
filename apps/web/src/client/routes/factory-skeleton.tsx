import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { Skeleton } from "@nocoo/basalt/components/skeleton";
import { Deferred } from "../components/layout/page-skeleton";
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
	return (
		<Deferred>
			<div role="status" aria-label="正在读取工厂快照" className="factory-skeleton space-y-4">
				<div className="flex gap-3">
					<Skeleton height={32} width="13%" />
					<Skeleton height={32} width="13%" />
					<Skeleton height={32} width="19%" />
				</div>
				<LayerCard padding="md" className="grid grid-cols-2 gap-4 lg:grid-cols-5">
					{["a", "b", "c", "d", "e"].map((id) => (
						<div key={id} className="space-y-3">
							<Skeleton height={10} width="50%" />
							<Skeleton height={26} width="50%" />
							<Skeleton height={10} width="70%" />
						</div>
					))}
				</LayerCard>
				<div className="grid gap-3 xl:grid-cols-2">
					{["commits", "delivery", "prs", "issues"].map((id) => (
						<LayerCard key={id} padding="md" className="space-y-4">
							<Skeleton height={12} width="24%" />
							<Skeleton height={220} />
						</LayerCard>
					))}
				</div>
			</div>
		</Deferred>
	);
}
