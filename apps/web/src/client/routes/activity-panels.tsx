import { Button, Link } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import type { ActivitySnapshot } from "../../lib/activity-types";
import { CandyBadge } from "../components/layout/candy-badge";
import { DataTimeSource } from "../components/layout/data-time";
import { Kpi, KpiRow } from "../components/layout/kpi";
import { ProjectLink } from "../components/layout/project-identity";
import { formatPreciseDate } from "../lib/format";
import {
	activityCount,
	activityObservedCount,
	activitySections,
	activitySummary,
} from "../viewmodels/activity";

function ActivityTime({ at }: { at: string | null }) {
	return at ? <time dateTime={at}>{formatPreciseDate(at, "Asia/Shanghai")}</time> : <>未知</>;
}

export function ActivityContent({
	snapshot,
	repository = false,
}: {
	snapshot: ActivitySnapshot;
	repository?: boolean;
}) {
	const totals = activitySummary(snapshot);
	return (
		<div className="min-w-0 space-y-basalt-layout">
			<DataTimeSource entries={[{ label: "当次活动", at: snapshot.fetchedAt }]} />
			<LayerCard data-testid="activity-window">
				<div className="flex flex-wrap items-center justify-between gap-basalt-space-lg">
					<p className="text-sm font-medium">当次窗口 · 北京时间（起点不含，终点包含）</p>
					<div className="flex flex-wrap gap-basalt-space-md">
						{snapshot.window.gap ? <CandyBadge tone="amber">窗口有间隔</CandyBadge> : null}
						{snapshot.window.first ? <CandyBadge tone="gray">首次窗口</CandyBadge> : null}
						{snapshot.truncated ? <CandyBadge tone="amber">数据已截断</CandyBadge> : null}
					</div>
				</div>
				<p className="mt-basalt-space-lg flex flex-wrap gap-x-basalt-space-md text-sm tabular-nums">
					<ActivityTime at={snapshot.window.since} />
					<span aria-hidden="true">→</span>
					<ActivityTime at={snapshot.window.until} />
				</p>
				<p className="mt-basalt-space-md break-words text-xs text-basalt-muted-foreground [overflow-wrap:anywhere]">
					数据时间：
					<ActivityTime at={snapshot.fetchedAt} /> · 运行 {snapshot.runId}
				</p>
				{snapshot.window.gap ? (
					<p className="mt-basalt-space-lg text-sm" role="note">
						窗口延伸至上次成功刷新；缺失日期或失败运行不算无活动。
					</p>
				) : null}
				{snapshot.window.first ? (
					<p className="mt-basalt-space-md text-sm" role="note">
						首次窗口仅覆盖已采集的有限回看范围，不代表此前没有活动。
					</p>
				) : null}
				{snapshot.truncated ? (
					<p className="mt-basalt-space-md text-sm" role="note">
						仅展示已保存的部分数据，数量不是完整总数。
					</p>
				) : null}
			</LayerCard>
			<KpiRow>
				<Kpi
					label="合并 PR"
					value={totals.merged}
					subtitle={`依赖 ${totals.dependency} · 其他 ${totals.other}`}
				/>
				<Kpi label="新开 Issue" value={totals.opened} />
				<Kpi label="关闭 Issue" value={totals.closed} />
				<Kpi label="发布版本（不含独立标签）" value={totals.releases} />
			</KpiRow>
			<div className="grid min-w-0 gap-basalt-layout xl:grid-cols-2">
				{activitySections(snapshot).map((section) => (
					<SectionRule
						key={section.key}
						title={section.title}
						data-testid={`activity-${section.key}`}
						actions={
							<CandyBadge
								tone={section.state === "unknown" || section.state === "partial" ? "amber" : "gray"}
							>
								{section.state === "unknown"
									? "未知"
									: `${section.state === "partial" ? "≥ " : ""}${section.rows.length} 条`}
							</CandyBadge>
						}
					>
						<LayerCard>
							{section.state === "unknown" ? (
								<p className="mb-basalt-space-lg text-sm" role="note">
									部分来源未知，不代表窗口内没有活动。
									{section.missingRepos.length
										? `缺少完整数据：${section.missingRepos.join("、")}`
										: "账户仓库范围未完整保存。"}
								</p>
							) : null}
							{section.state === "partial" ? (
								<p className="mb-basalt-space-lg text-sm" role="note">
									记录不完整，不代表窗口内没有活动；当前数量仅为下界。
								</p>
							) : null}
							{section.state === "empty" ? (
								<p className="text-sm text-basalt-muted-foreground">窗口内没有记录</p>
							) : null}
							{section.rows.length ? (
								<ul className="space-y-basalt-layout-sm">
									{section.rows.map((row) => (
										<li key={row.id} className="min-w-0 space-y-basalt-space-xs">
											<Link
												href={`/repos/${row.repo}`}
												className="block break-words text-sm font-medium [overflow-wrap:anywhere]"
											>
												{row.title}
											</Link>
											<p className="break-words text-xs text-basalt-muted-foreground [overflow-wrap:anywhere]">
												{row.repo} · {row.kind} · <ActivityTime at={row.at} />
											</p>
										</li>
									))}
								</ul>
							) : null}
						</LayerCard>
					</SectionRule>
				))}
			</div>
			{repository ? (
				<SectionRule title="当前仓库快照">
					<div className="space-y-basalt-layout-sm">
						{snapshot.repos.map((repo) => (
							<LayerCard key={repo.repo}>
								<ProjectLink repo={repo.repo} />
								<dl className="mt-basalt-layout-sm grid grid-cols-2 gap-basalt-layout-sm text-sm sm:grid-cols-3">
									<div>
										<dt className="text-basalt-muted-foreground">未结 PR</dt>
										<dd className="tabular-nums">
											{activityObservedCount(
												repo.snapshot.open_prs?.length ?? null,
												repo.coverage["snapshot.open_prs"],
												snapshot.truncated,
											)}
										</dd>
									</div>
									<div>
										<dt className="text-basalt-muted-foreground">
											未结 Issue · 依赖 / 安全 / 其他
										</dt>
										<dd className="tabular-nums">
											{activityObservedCount(
												repo.snapshot.open_issues?.dependency.length ?? null,
												repo.coverage["snapshot.open_issues"],
												snapshot.truncated,
											)}{" "}
											/{" "}
											{activityObservedCount(
												repo.snapshot.open_issues?.security.length ?? null,
												repo.coverage["snapshot.open_issues"],
												snapshot.truncated,
											)}{" "}
											/{" "}
											{activityObservedCount(
												repo.snapshot.open_issues?.other.length ?? null,
												repo.coverage["snapshot.open_issues"],
												snapshot.truncated,
											)}
										</dd>
									</div>
									<div>
										<dt className="text-basalt-muted-foreground">提交 · 默认 / 其他分支</dt>
										<dd className="tabular-nums">
											{activityObservedCount(
												repo.commits.default,
												repo.coverage.commits,
												snapshot.truncated,
											)}{" "}
											/{" "}
											{activityObservedCount(
												repo.commits.other,
												repo.coverage.other_commits,
												snapshot.truncated,
											)}
										</dd>
									</div>
									<div>
										<dt className="text-basalt-muted-foreground">Dependabot</dt>
										<dd className="tabular-nums">
											{activityObservedCount(repo.snapshot.dependabot, repo.coverage.dependabot)}
										</dd>
									</div>
									<div>
										<dt className="text-basalt-muted-foreground">code scanning</dt>
										<dd className="tabular-nums">
											{activityObservedCount(
												repo.snapshot.code_scanning,
												repo.coverage.code_scanning,
											)}
										</dd>
									</div>
									<div>
										<dt className="text-basalt-muted-foreground">最近成功部署</dt>
										<dd>
											<ActivityTime
												at={
													repo.coverage.deploy?.status === "complete" &&
													!repo.coverage.deploy.truncated
														? repo.deploy.last_success_at
														: null
												}
											/>
										</dd>
									</div>
								</dl>
							</LayerCard>
						))}
						{snapshot.repos.length === 0 ? (
							<p className="text-sm text-basalt-muted-foreground">
								{snapshot.truncated
									? "该仓库的活动记录未完整保存，不代表没有活动。"
									: "该仓库未包含在当次快速刷新中，不代表没有活动。"}
							</p>
						) : null}
					</div>
				</SectionRule>
			) : (
				<SectionRule title="贡献绿格" data-testid="activity-contributions">
					<p className="mb-basalt-layout-sm text-xs text-basalt-muted-foreground">
						Asia/Shanghai · 请求区间按北京日划分，贡献数由 GitHub 返回；原生日历日期保留 GitHub
						归属，不代表已转换时区。
					</p>
					{snapshot.contributions ? (
						<div className="grid min-w-0 gap-basalt-layout-sm sm:grid-cols-2">
							{snapshot.contributions.days.map((day) => (
								<LayerCard key={day.date}>
									<div className="flex flex-wrap items-center justify-between gap-basalt-space-lg">
										<h3 className="text-sm font-medium tabular-nums">{day.date}</h3>
										<CandyBadge tone={day.partial ? "amber" : "green"}>
											{day.partial ? "当天未结束" : "完整北京日"}
										</CandyBadge>
									</div>
									<p className="mt-basalt-layout-sm text-xs text-basalt-muted-foreground">
										GitHub reported contributions（请求区间）
									</p>
									<p className="mt-basalt-space-md text-2xl font-semibold tabular-nums">
										{activityCount(day.count)}
									</p>
									{day.coverage.status !== "complete" || day.coverage.truncated ? (
										<p className="mt-basalt-space-md text-xs" role="note">
											贡献来源不完整或未知，不能当作零贡献。
										</p>
									) : null}
									<dl className="mt-basalt-layout-sm grid grid-cols-2 gap-basalt-space-lg text-xs">
										{(
											[
												["提交", day.types.commits],
												["Issue", day.types.issues],
												["PR", day.types.pullRequests],
												["Review", day.types.pullRequestReviews],
												["私有贡献", day.types.restricted],
												["仓库", day.types.repositories],
											] as const
										).map(([label, value]) => (
											<div key={label} className="flex justify-between gap-basalt-space-md">
												<dt className="text-basalt-muted-foreground">{label}</dt>
												<dd className="tabular-nums">{activityCount(value)}</dd>
											</div>
										))}
									</dl>
									<p className="mt-basalt-layout-sm break-words text-xs text-basalt-muted-foreground">
										<ActivityTime at={day.since} /> → <ActivityTime at={day.until} />
									</p>
									{day.nativeCalendar ? (
										<div className="mt-basalt-layout-sm text-xs text-basalt-muted-foreground">
											<p>GitHub 原生日历（github，未转换时区）</p>
											<p className="mt-basalt-space-xs tabular-nums">
												{day.nativeCalendar.days
													.map((native) => `${native.date}：${activityCount(native.count)}`)
													.join(" · ") || "日期记录未知"}
											</p>
										</div>
									) : (
										<p className="mt-basalt-layout-sm text-xs text-basalt-muted-foreground">
											GitHub 原生日历来源未知
										</p>
									)}
								</LayerCard>
							))}
						</div>
					) : (
						<LayerCard>
							<p className="text-sm">贡献数据未知，尚无可用的当次贡献观测。</p>
						</LayerCard>
					)}
				</SectionRule>
			)}
		</div>
	);
}

export function ActivityReadError({ retry }: { retry: () => void }) {
	return (
		<LayerCard>
			<LayerCard.Empty
				title="暂时无法读取当次活动"
				description="未获得完整活动窗口，请重试；读取不会发起采集。"
				action={
					<Button variant="secondary" size="sm" onClick={retry}>
						重试
					</Button>
				}
			/>
		</LayerCard>
	);
}
