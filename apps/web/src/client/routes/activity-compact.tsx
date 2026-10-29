import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { StatStrip } from "@nocoo/basalt/components/stat-strip";
import { CalendarDays, Clock3, Database } from "lucide-react";
import type { ActivitySnapshot } from "../../lib/activity-types";
import { DataTimeSource } from "../components/layout/data-time";
import { HelpTooltip } from "../components/layout/help-tooltip";
import { IconLabel } from "../components/layout/icon-label";
import { ProjectLink } from "../components/layout/project-identity";
import { formatPreciseDate } from "../lib/format";
import { activitySections, activitySummary } from "../viewmodels/activity";
import {
	ActivitySectionBody,
	activitySectionBadge,
	activitySectionIcon,
	RepoSnapshotFields,
} from "./activity-panels";

function ActivityTime({ at }: { at: string | null }) {
	return at ? <time dateTime={at}>{formatPreciseDate(at, "Asia/Shanghai")}</time> : <>未知</>;
}

/**
 * One repository's current window at overview density: the same window, totals,
 * section notes and snapshot fields as the account page, without six stacked cards.
 */
export function CompactRepoActivity({ snapshot }: { snapshot: ActivitySnapshot }) {
	const totals = activitySummary(snapshot);
	const sections = activitySections(snapshot);
	const incomplete = sections.some((section) => section.state === "partial");
	return (
		<div className="flex min-w-0 flex-col gap-basalt-layout">
			<DataTimeSource entries={[{ label: "当次活动", at: snapshot.fetchedAt }]} />
			<LayerCard data-testid="activity-window">
				<div className="flex flex-wrap items-center gap-x-basalt-space-lg gap-y-basalt-space-sm text-xs">
					<h2 className="flex items-center gap-2 text-sm font-medium">
						<CalendarDays
							className="size-4 shrink-0 text-basalt-muted-foreground"
							strokeWidth={1.5}
							aria-hidden="true"
						/>
						当次窗口
						<HelpTooltip label="当次窗口说明">
							<p>北京时间，起点不含、终点包含。</p>
							<p>窗口延伸至上次成功刷新；缺失日期或失败运行不算无活动。</p>
							<p>首次窗口仅覆盖已采集的有限回看范围，不代表此前没有活动。</p>
							<p>已保存的部分数据不是完整总数。</p>
						</HelpTooltip>
					</h2>
					<span className="flex items-center gap-1.5 tabular-nums">
						<Clock3
							className="size-3.5 shrink-0 text-basalt-muted-foreground"
							strokeWidth={1.5}
							aria-hidden="true"
						/>
						<ActivityTime at={snapshot.window.since} /> →{" "}
						<ActivityTime at={snapshot.window.until} />
					</span>
					{snapshot.window.gap ? <span>窗口有间隔</span> : null}
					{snapshot.window.first ? <span>首次窗口</span> : null}
					{snapshot.truncated ? <span>数据已截断</span> : null}
					<span className="flex items-center gap-1.5 text-basalt-muted-foreground">
						<Database className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
						数据时间：
						<ActivityTime at={snapshot.fetchedAt} /> · 运行{" "}
						<span className="break-all">{snapshot.runId}</span>
					</span>
				</div>
			</LayerCard>
			<StatStrip
				className="[&>div]:p-3 md:grid-cols-3 xl:grid-cols-6"
				items={[
					{ label: "合并 PR", value: totals.merged },
					{ label: "依赖 PR", value: totals.dependency },
					{ label: "其他 PR", value: totals.other },
					{ label: "新开 Issue", value: totals.opened },
					{ label: "关闭 Issue", value: totals.closed },
					{ label: <span title="不含独立标签">发布版本</span>, value: totals.releases },
				]}
			/>
			{incomplete ? (
				<p className="text-xs text-basalt-muted-foreground" role="note">
					部分区块记录不完整，不代表窗口内没有活动；各区块数量仅为下界。
				</p>
			) : null}
			<div className="grid min-w-0 gap-basalt-layout-sm sm:grid-cols-2 xl:grid-cols-3">
				{sections.map((section) => (
					<LayerCard
						key={section.key}
						padding="md"
						className="flex min-w-0 flex-col"
						data-testid={`activity-${section.key}`}
					>
						<div className="flex items-center justify-between gap-basalt-space-md">
							<h3 className="text-sm font-medium">
								<IconLabel icon={activitySectionIcon(section.key)}>{section.title}</IconLabel>
							</h3>
							{activitySectionBadge(section)}
						</div>
						<div className="mt-basalt-space-sm min-w-0">
							<ActivitySectionBody section={section} hintedElsewhere={incomplete} />
						</div>
					</LayerCard>
				))}
			</div>
			{snapshot.repos.map((repo) => (
				<LayerCard key={repo.repo} padding="md">
					<ProjectLink repo={repo.repo} />
					<RepoSnapshotFields repo={repo} snapshot={snapshot} />
				</LayerCard>
			))}
			{snapshot.repos.length === 0 ? (
				<LayerCard padding="md">
					<p className="text-sm text-basalt-muted-foreground">
						{snapshot.truncated
							? "该仓库的活动记录未完整保存，不代表没有活动。"
							: "已保存的活动窗口不包含该仓库，不代表没有活动。"}
					</p>
				</LayerCard>
			) : null}
		</div>
	);
}
