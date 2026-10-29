import { Button, Link } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import {
	Bot,
	Box,
	CalendarDays,
	CircleDot,
	Clock3,
	Database,
	GitCommit,
	GitMerge,
	GitPullRequest,
	Lock,
	MessageSquare,
	Rocket,
	ScanSearch,
	Tag,
	Workflow,
} from "lucide-react";
import type { ActivitySnapshot } from "../../lib/activity-types";
import { CandyBadge } from "../components/layout/candy-badge";
import { DataTimeSource } from "../components/layout/data-time";
import { HelpTooltip } from "../components/layout/help-tooltip";
import { IconLabel } from "../components/layout/icon-label";
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

type ActivitySection = ReturnType<typeof activitySections>[number];

type ActivityRepo = ActivitySnapshot["repos"][number];

const SECTION_ICONS = {
	merged: GitMerge,
	opened: GitPullRequest,
	closed: CircleDot,
	releases: Tag,
	ci: Workflow,
	deploy: Rocket,
} as const;

const CONTRIBUTION_TYPES = [
	{ key: "commits", label: "提交", icon: GitCommit },
	{ key: "issues", label: "Issue", icon: CircleDot },
	{ key: "pullRequests", label: "PR", icon: GitPullRequest },
	{ key: "pullRequestReviews", label: "Review", icon: MessageSquare },
	{ key: "restricted", label: "私有贡献", icon: Lock },
	{ key: "repositories", label: "仓库", icon: Box },
] as const;

export function activitySectionIcon(key: string) {
	return SECTION_ICONS[key as keyof typeof SECTION_ICONS] ?? Tag;
}

function rowIcon(sectionKey: string, kind: string) {
	if (sectionKey === "ci") return Workflow;
	if (sectionKey === "deploy") return Rocket;
	if (kind.startsWith("PR")) return sectionKey === "merged" ? GitMerge : GitPullRequest;
	if (kind.startsWith("Issue")) return CircleDot;
	return Tag;
}

/** One activity section's notes and rows, shared by the wide and compact layouts. */
export function ActivitySectionBody({
	section,
	hintedElsewhere = false,
}: {
	section: ActivitySection;
	hintedElsewhere?: boolean;
}) {
	return (
		<>
			{section.state === "unknown" ? (
				<p className="mb-basalt-space-lg text-sm" role="note">
					部分来源未知，不代表窗口内没有活动。
					{section.missingRepos.length
						? `缺少完整数据：${section.missingRepos.join("、")}`
						: "账户仓库范围未完整保存。"}
				</p>
			) : null}
			{section.state === "partial" && !hintedElsewhere ? (
				<p className="mb-basalt-space-lg text-sm" role="note">
					记录不完整，不代表窗口内没有活动；当前数量仅为下界。
				</p>
			) : null}
			{section.state === "empty" ? (
				<p className="text-sm text-basalt-muted-foreground">窗口内没有记录</p>
			) : null}
			{section.rows.length ? (
				<ul className="space-y-basalt-layout-sm">
					{section.rows.map((row) => {
						const RowIcon = rowIcon(section.key, row.kind);
						return (
							<li key={row.id} className="flex min-w-0 items-start gap-2">
								<RowIcon
									className="mt-0.5 size-4 shrink-0 text-basalt-muted-foreground"
									strokeWidth={1.5}
									aria-hidden="true"
								/>
								<div className="min-w-0 flex-1 space-y-basalt-space-xs">
									<Link
										href={`/repos/${row.repo}`}
										className="block break-words text-sm font-medium [overflow-wrap:anywhere]"
									>
										{row.title}
									</Link>
									<div className="flex flex-wrap items-center gap-x-basalt-space-lg gap-y-basalt-space-xs text-xs text-basalt-muted-foreground">
										<ProjectLink
											repo={row.repo}
											size={16}
											className="text-xs font-normal text-basalt-muted-foreground"
										/>
										{section.key === "ci" || section.key === "deploy" ? (
											<CandyBadge tone="gray">{row.kind}</CandyBadge>
										) : (
											<IconLabel icon={Tag} iconClassName="size-3.5">
												{row.kind}
											</IconLabel>
										)}
										<IconLabel icon={Clock3} iconClassName="size-3.5">
											<ActivityTime at={row.at} />
										</IconLabel>
									</div>
								</div>
							</li>
						);
					})}
				</ul>
			) : null}
		</>
	);
}

/** The repository's observed snapshot fields; callers own the surrounding card. */
export function RepoSnapshotFields({
	repo,
	snapshot,
}: {
	repo: ActivityRepo;
	snapshot: ActivitySnapshot;
}) {
	return (
		<dl className="mt-basalt-layout-sm grid grid-cols-2 gap-x-basalt-layout gap-y-basalt-layout-sm sm:grid-cols-3">
			<div className="min-w-0 space-y-basalt-space-xs">
				<dt className="text-basalt-xs text-basalt-muted-foreground">
					<IconLabel icon={GitPullRequest} iconClassName="size-3.5">
						未结 PR
					</IconLabel>
				</dt>
				<dd className="font-medium tabular-nums">
					{activityObservedCount(
						repo.snapshot.open_prs?.length ?? null,
						repo.coverage["snapshot.open_prs"],
						snapshot.truncated,
					)}
				</dd>
			</div>
			<div className="min-w-0 space-y-basalt-space-xs">
				<dt className="text-basalt-xs text-basalt-muted-foreground">
					<IconLabel icon={CircleDot} iconClassName="size-3.5">
						未结 Issue · 依赖 / 安全 / 其他
					</IconLabel>
				</dt>
				<dd className="font-medium tabular-nums">
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
			<div className="min-w-0 space-y-basalt-space-xs">
				<dt className="text-basalt-xs text-basalt-muted-foreground">
					<IconLabel icon={GitCommit} iconClassName="size-3.5">
						提交 · 默认 / 其他分支
					</IconLabel>
				</dt>
				<dd className="font-medium tabular-nums">
					{activityObservedCount(repo.commits.default, repo.coverage.commits, snapshot.truncated)} /{" "}
					{activityObservedCount(
						repo.commits.other,
						repo.coverage.other_commits,
						snapshot.truncated,
					)}
					{repo.commits.deferred?.map((group) => (
						<p
							key={group.runId}
							className="mt-basalt-space-xs text-basalt-xs font-normal text-basalt-muted-foreground"
						>
							{`补录 ${group.items.length} 个默认分支提交 · 归属窗口 `}
							<ActivityTime at={group.window.since} /> → <ActivityTime at={group.window.until} />
							（不计入本窗口）
						</p>
					))}
				</dd>
			</div>
			<div className="min-w-0 space-y-basalt-space-xs">
				<dt className="text-basalt-xs text-basalt-muted-foreground">
					<IconLabel icon={Bot} iconClassName="size-3.5">
						Dependabot
					</IconLabel>
				</dt>
				<dd className="font-medium tabular-nums">
					{activityObservedCount(repo.snapshot.dependabot, repo.coverage.dependabot)}
				</dd>
			</div>
			<div className="min-w-0 space-y-basalt-space-xs">
				<dt className="text-basalt-xs text-basalt-muted-foreground">
					<IconLabel icon={ScanSearch} iconClassName="size-3.5">
						code scanning
					</IconLabel>
				</dt>
				<dd className="font-medium tabular-nums">
					{activityObservedCount(repo.snapshot.code_scanning, repo.coverage.code_scanning)}
				</dd>
			</div>
			<div className="min-w-0 space-y-basalt-space-xs">
				<dt className="text-basalt-xs text-basalt-muted-foreground">
					<IconLabel icon={Rocket} iconClassName="size-3.5">
						最近成功部署
					</IconLabel>
				</dt>
				<dd className="font-medium">
					<ActivityTime
						at={
							repo.coverage.deploy?.status === "complete" && !repo.coverage.deploy.truncated
								? repo.deploy.last_success_at
								: null
						}
					/>
				</dd>
			</div>
		</dl>
	);
}

export function activitySectionBadge(section: ActivitySection) {
	return (
		<CandyBadge
			tone={section.state === "unknown" || section.state === "partial" ? "amber" : "gray"}
		>
			{section.state === "unknown"
				? "未知"
				: `${section.state === "partial" ? "≥ " : ""}${section.rows.length} 条`}
		</CandyBadge>
	);
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
					<div className="flex flex-wrap gap-basalt-space-md">
						{snapshot.window.gap ? <CandyBadge tone="amber">窗口有间隔</CandyBadge> : null}
						{snapshot.window.first ? <CandyBadge tone="gray">首次窗口</CandyBadge> : null}
						{snapshot.truncated ? <CandyBadge tone="amber">数据已截断</CandyBadge> : null}
					</div>
				</div>
				<p className="mt-basalt-space-lg flex flex-wrap items-center gap-x-basalt-space-md text-sm tabular-nums">
					<Clock3
						className="size-4 shrink-0 text-basalt-muted-foreground"
						strokeWidth={1.5}
						aria-hidden="true"
					/>
					<ActivityTime at={snapshot.window.since} />
					<span aria-hidden="true">→</span>
					<ActivityTime at={snapshot.window.until} />
				</p>
				<p className="mt-basalt-space-md flex flex-wrap items-center gap-x-basalt-space-xs break-words text-xs text-basalt-muted-foreground [overflow-wrap:anywhere]">
					<Database className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
					数据时间：
					<ActivityTime at={snapshot.fetchedAt} /> · 运行 {snapshot.runId}
				</p>
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
						title={<IconLabel icon={activitySectionIcon(section.key)}>{section.title}</IconLabel>}
						data-testid={`activity-${section.key}`}
						actions={activitySectionBadge(section)}
					>
						<LayerCard>
							<ActivitySectionBody section={section} />
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
								<RepoSnapshotFields repo={repo} snapshot={snapshot} />
							</LayerCard>
						))}
						{snapshot.repos.length === 0 ? (
							<p className="text-sm text-basalt-muted-foreground">
								{snapshot.truncated
									? "该仓库的活动记录未完整保存，不代表没有活动。"
									: "已保存的活动窗口不包含该仓库，不代表没有活动。"}
							</p>
						) : null}
					</div>
				</SectionRule>
			) : (
				<SectionRule
					title={
						<IconLabel
							icon={CalendarDays}
							hint="Asia/Shanghai · 请求区间按北京日划分，贡献数由 GitHub 返回；原生日历日期保留 GitHub 归属，不代表已转换时区。"
							hintLabel="贡献绿格说明"
						>
							贡献绿格
						</IconLabel>
					}
					data-testid="activity-contributions"
				>
					{snapshot.contributions ? (
						<div className="grid min-w-0 gap-basalt-layout-sm sm:grid-cols-2">
							{snapshot.contributions.days.map((day) => (
								<LayerCard key={day.date}>
									<div className="flex flex-wrap items-center justify-between gap-basalt-space-lg">
										<h3 className="flex items-center gap-2 text-sm font-medium tabular-nums">
											<CalendarDays
												className="size-4 shrink-0 text-basalt-muted-foreground"
												strokeWidth={1.5}
												aria-hidden="true"
											/>
											{day.date}
										</h3>
										<CandyBadge tone={day.partial ? "amber" : "green"}>
											{day.partial ? "当天未结束" : "完整北京日"}
										</CandyBadge>
									</div>
									<p className="mt-basalt-layout-sm flex items-center gap-1.5 text-xs text-basalt-muted-foreground">
										<GitCommit className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
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
										{CONTRIBUTION_TYPES.map(({ key, label, icon }) => (
											<div
												key={key}
												className="flex items-center justify-between gap-basalt-space-md"
											>
												<dt className="text-basalt-muted-foreground">
													<IconLabel icon={icon} iconClassName="size-3.5">
														{label}
													</IconLabel>
												</dt>
												<dd className="tabular-nums">{activityCount(day.types[key])}</dd>
											</div>
										))}
									</dl>
									<p className="mt-basalt-layout-sm flex flex-wrap items-center gap-1.5 break-words text-xs text-basalt-muted-foreground">
										<Clock3 className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
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
