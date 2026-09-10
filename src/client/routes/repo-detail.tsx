import {
	Avatar,
	AvatarFallback,
	AvatarImage,
	Button,
	Link,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	toast,
} from "@nocoo/basalt";
import { AreaChart } from "@nocoo/basalt/charts/area";
import { DonutChart } from "@nocoo/basalt/charts/donut";
import { Code } from "@nocoo/basalt/components/code";
import { DescriptionList } from "@nocoo/basalt/components/description-list";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { ScrollArea } from "@nocoo/basalt/components/scroll-area";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@nocoo/basalt/components/table";
import {
	Box,
	Bug,
	CircleDot,
	Code2,
	Download,
	ExternalLink,
	Eye,
	FolderDown,
	GitFork,
	GitPullRequest,
	Play,
	ShieldAlert,
	Star,
	Tag,
	Users,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { CandyBadge } from "../components/layout/candy-badge";
import { ChartBrick, ChartEmpty, ChartRow } from "../components/layout/chart-brick";
import { SnapshotDescription, TableScroll } from "../components/layout/collection-chrome";
import { Kpi, KpiRow } from "../components/layout/kpi";
import {
	ChartSkeleton,
	DetailSkeleton,
	PeopleSkeleton,
	TableSkeleton,
} from "../components/layout/page-skeleton";
import { RefreshButton } from "../components/layout/refresh-button";
import { ChurnMeter, LabelChips, PersonCell } from "../components/layout/table-chrome";
import { catchLoad, missingTitle } from "../lib/error-ui";
import {
	churnFilled,
	conclusionBadgeVariant,
	DATE_CELL,
	formatConclusion,
	formatCount,
	formatDate,
	formatReview,
	formatRunStatus,
	NUM_CELL,
	NUM_HEAD,
	reviewBadgeVariant,
} from "../lib/format";
import type { IssuesSnapshot } from "../viewmodels/issues";
import type { PullsSnapshot } from "../viewmodels/pulls";
import { requestRefresh } from "../viewmodels/refresh";
import {
	isValidRepoPart,
	loadRepoTab,
	type RepoActions,
	type RepoContributors,
	type RepoDetails,
	type RepoLanguages,
	type RepoReleases,
	type RepoSecurity,
	type RepoTab,
	type RepoTraffic,
	repoKind,
	securityUnavailable,
	sortedLanguages,
	trafficForbidden,
	trafficPoints,
} from "../viewmodels/repo-detail";

async function fetchTab<T extends { account_id: string }>(
	owner: string,
	name: string,
	tab: RepoTab,
	auto: Set<string>,
): Promise<T | { missing: true }> {
	const first = await loadRepoTab<T>(owner, name, tab);
	if ("invalid" in first) {
		return { missing: true };
	}
	const key = `${owner}/${name}:${tab}`;
	if ("missing" in first && !auto.has(key)) {
		auto.add(key);
		await requestRefresh(repoKind(owner, name, tab));
		const again = await loadRepoTab<T>(owner, name, tab);
		if ("invalid" in again || "missing" in again) {
			return { missing: true };
		}
		return again;
	}
	return first;
}

function TabWell({ children, flush = false }: { children: ReactNode; flush?: boolean }) {
	return (
		<LayerCard>
			<LayerCard.Well {...(flush ? { className: "p-0" } : {})}>
				{flush ? <TableScroll label="仓库数据">{children}</TableScroll> : children}
			</LayerCard.Well>
		</LayerCard>
	);
}

export function RepoDetailPage() {
	const params = useParams();
	const owner = params.owner ?? "";
	const name = params.name ?? "";
	const valid = isValidRepoPart(owner) && isValidRepoPart(name);
	const [tab, setTab] = useState<RepoTab>("details");
	const [snap, setSnap] = useState<RepoDetails | { missing: true } | { invalid: true } | null>(
		null,
	);
	const [security, setSecurity] = useState<RepoSecurity | { missing: true } | null>(null);
	const [traffic, setTraffic] = useState<RepoTraffic | { missing: true } | null>(null);
	const [actions, setActions] = useState<RepoActions | { missing: true } | null>(null);
	const [releases, setReleases] = useState<RepoReleases | { missing: true } | null>(null);
	const [issues, setIssues] = useState<IssuesSnapshot | { missing: true } | null>(null);
	const [pulls, setPulls] = useState<PullsSnapshot | { missing: true } | null>(null);
	const [languages, setLanguages] = useState<RepoLanguages | { missing: true } | null>(null);
	const [contributors, setContributors] = useState<RepoContributors | { missing: true } | null>(
		null,
	);
	const refreshed = useRef(new Set<string>());
	const gen = useRef(0);

	function onLoadError(err: unknown): void {
		const missing = catchLoad(err, (message) => {
			toast.error(message);
		});
		if (missing) {
			setSnap(missing);
		}
	}

	useEffect(() => {
		let cancelled = false;
		gen.current += 1;
		setSnap(null);
		setSecurity(null);
		setTraffic(null);
		setActions(null);
		setReleases(null);
		setIssues(null);
		setPulls(null);
		setLanguages(null);
		setContributors(null);
		if (!valid) {
			setSnap({ invalid: true });
			return;
		}
		void loadRepoTab<RepoDetails>(owner, name, "details")
			.then(async (next) => {
				if (cancelled) {
					return;
				}
				if ("missing" in next && !refreshed.current.has(`${owner}/${name}:details`)) {
					refreshed.current.add(`${owner}/${name}:details`);
					try {
						await requestRefresh(repoKind(owner, name, "details"));
						if (cancelled) {
							return;
						}
						setSnap(await loadRepoTab<RepoDetails>(owner, name, "details"));
					} catch (err: unknown) {
						if (cancelled) {
							return;
						}
						const failed = catchLoad(err, (message) => {
							toast.error(message);
						});
						setSnap(failed ?? next);
					}
					return;
				}
				setSnap(next);
			})
			.catch((err: unknown) => {
				if (cancelled) {
					return;
				}
				const missing = catchLoad(err, (message) => {
					toast.error(message);
				});
				if (missing) {
					setSnap(missing);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [owner, name, valid]);

	useEffect(() => {
		if (!valid) {
			return;
		}
		let cancelled = false;
		function apply<T>(
			setter: (value: T | { missing: true }) => void,
			value: T | { missing: true },
		) {
			if (!cancelled) {
				setter(value);
			}
		}
		function onTabError(err: unknown): void {
			if (cancelled) {
				return;
			}
			const missing = catchLoad(err, (message) => {
				toast.error(message);
			});
			if (missing) {
				setSnap(missing);
				return;
			}
			// A failed initial fetch must leave the loading state so the user can retry.
			const setCurrent = {
				details: setSnap,
				security: setSecurity,
				traffic: setTraffic,
				actions: setActions,
				releases: setReleases,
				issues: setIssues,
				prs: setPulls,
				languages: setLanguages,
				contributors: setContributors,
			}[tab];
			setCurrent({ missing: true });
		}
		if (tab === "security") {
			void fetchTab<RepoSecurity>(owner, name, "security", refreshed.current)
				.then((value) => apply(setSecurity, value))
				.catch(onTabError);
		}
		if (tab === "traffic") {
			void fetchTab<RepoTraffic>(owner, name, "traffic", refreshed.current)
				.then((value) => apply(setTraffic, value))
				.catch(onTabError);
		}
		if (tab === "actions") {
			void fetchTab<RepoActions>(owner, name, "actions", refreshed.current)
				.then((value) => apply(setActions, value))
				.catch(onTabError);
		}
		if (tab === "releases") {
			void fetchTab<RepoReleases>(owner, name, "releases", refreshed.current)
				.then((value) => apply(setReleases, value))
				.catch(onTabError);
		}
		if (tab === "issues") {
			void fetchTab<IssuesSnapshot>(owner, name, "issues", refreshed.current)
				.then((value) => apply(setIssues, value))
				.catch(onTabError);
		}
		if (tab === "prs") {
			void fetchTab<PullsSnapshot>(owner, name, "prs", refreshed.current)
				.then((value) => apply(setPulls, value))
				.catch(onTabError);
		}
		if (tab === "languages") {
			void fetchTab<RepoLanguages>(owner, name, "languages", refreshed.current)
				.then((value) => apply(setLanguages, value))
				.catch(onTabError);
		}
		if (tab === "contributors") {
			void fetchTab<RepoContributors>(owner, name, "contributors", refreshed.current)
				.then((value) => apply(setContributors, value))
				.catch(onTabError);
		}
		return () => {
			cancelled = true;
		};
	}, [owner, name, valid, tab]);

	if (!valid || (snap && "invalid" in snap)) {
		return (
			<div className="space-y-8">
				<PageHeader title="仓库" />
				<TabWell>
					<LayerCard.Empty
						icon={<Box />}
						title="无效仓库"
						description="owner 或 name 不符合 GitHub 规则。"
					/>
				</TabWell>
			</div>
		);
	}

	if (snap && "missing" in snap) {
		return (
			<div className="space-y-8">
				<PageHeader
					title={
						<span className="[overflow-wrap:anywhere]">
							{owner}/<wbr />
							{name}
						</span>
					}
				/>
				<TabWell>
					<LayerCard.Empty
						icon={<Box />}
						title={missingTitle(snap)}
						description="先添加 PAT 或刷新。"
					/>
					<div className="pt-2">
						<RefreshButton
							run={() => {
								const mine = gen.current;
								return requestRefresh(repoKind(owner, name, "details"))
									.then(async () => {
										if (mine !== gen.current) {
											return false;
										}
										const next = await loadRepoTab<RepoDetails>(owner, name, "details");
										if (mine !== gen.current) {
											return false;
										}
										setSnap(next);
										return undefined;
									})
									.catch((err: unknown) => {
										if (mine !== gen.current) {
											return false;
										}
										onLoadError(err);
										return false;
									});
							}}
						/>
					</div>
				</TabWell>
			</div>
		);
	}

	if (!snap) {
		return (
			<div className="space-y-8">
				<PageHeader
					title={
						<span className="[overflow-wrap:anywhere]">
							{owner}/<wbr />
							{name}
						</span>
					}
				/>
				<DetailSkeleton label="加载仓库" />
			</div>
		);
	}

	const activeSnapshot =
		tab === "details"
			? snap
			: tab === "security"
				? security
				: tab === "traffic"
					? traffic
					: tab === "actions"
						? actions
						: tab === "releases"
							? releases
							: tab === "issues"
								? issues
								: tab === "prs"
									? pulls
									: tab === "languages"
										? languages
										: contributors;
	const current = activeSnapshot && !("missing" in activeSnapshot) ? activeSnapshot : null;
	const truncated = current?.truncated;

	return (
		<div className="space-y-8" data-testid="repo-detail">
			<PageHeader
				title={
					<span className="[overflow-wrap:anywhere]">
						{owner}/<wbr />
						{name}
					</span>
				}
				description={
					current ? (
						<SnapshotDescription
							description={snap.description ?? "仓库概览、开发动态与协作数据"}
							fetchedAt={current.fetched_at}
						/>
					) : (
						(snap.description ?? name)
					)
				}
				actions={
					<>
						{truncated ? <CandyBadge tone="amber">已截断</CandyBadge> : null}
						<Button variant="secondary" size="sm" asChild>
							<a href={snap.url} target="_blank" rel="noreferrer">
								<ExternalLink className="size-3.5" aria-hidden="true" />
								GitHub
							</a>
						</Button>
						<RefreshButton
							run={() => {
								const mine = gen.current;
								function applyIfCurrent<T>(setter: (value: T) => void): (value: T) => void {
									return (value) => {
										if (mine === gen.current) {
											setter(value);
										}
									};
								}
								return requestRefresh(repoKind(owner, name, tab))
									.then(async () => {
										if (mine !== gen.current) {
											return false;
										}
										if (tab === "details") {
											return loadRepoTab<RepoDetails>(owner, name, "details").then(
												applyIfCurrent(setSnap),
											);
										}
										if (tab === "security") {
											return fetchTab<RepoSecurity>(
												owner,
												name,
												"security",
												refreshed.current,
											).then(applyIfCurrent(setSecurity));
										}
										if (tab === "actions") {
											return fetchTab<RepoActions>(owner, name, "actions", refreshed.current).then(
												applyIfCurrent(setActions),
											);
										}
										if (tab === "releases") {
											return fetchTab<RepoReleases>(
												owner,
												name,
												"releases",
												refreshed.current,
											).then(applyIfCurrent(setReleases));
										}
										if (tab === "issues") {
											return fetchTab<IssuesSnapshot>(
												owner,
												name,
												"issues",
												refreshed.current,
											).then(applyIfCurrent(setIssues));
										}
										if (tab === "prs") {
											return fetchTab<PullsSnapshot>(owner, name, "prs", refreshed.current).then(
												applyIfCurrent(setPulls),
											);
										}
										if (tab === "languages") {
											return fetchTab<RepoLanguages>(
												owner,
												name,
												"languages",
												refreshed.current,
											).then(applyIfCurrent(setLanguages));
										}
										if (tab === "contributors") {
											return fetchTab<RepoContributors>(
												owner,
												name,
												"contributors",
												refreshed.current,
											).then(applyIfCurrent(setContributors));
										}
										return fetchTab<RepoTraffic>(owner, name, "traffic", refreshed.current).then(
											applyIfCurrent(setTraffic),
										);
									})
									.then((result) => {
										if (mine !== gen.current) {
											return false;
										}
										return result;
									})
									.catch((err: unknown) => {
										if (mine !== gen.current) {
											return false;
										}
										throw err;
									});
							}}
							onError={onLoadError}
						/>
					</>
				}
			/>
			<Tabs value={tab} onValueChange={(value) => setTab(value as RepoTab)} className="min-w-0">
				<ScrollArea orientation="horizontal" aria-label="仓库标签页" className="mb-6">
					<TabsList className="w-max min-w-full flex-nowrap" aria-label="仓库详情">
						<TabsTrigger value="details" className="gap-1.5 whitespace-nowrap">
							<Box className="size-3.5" aria-hidden="true" />
							概览
						</TabsTrigger>
						<TabsTrigger value="security" className="gap-1.5 whitespace-nowrap">
							<ShieldAlert className="size-3.5" aria-hidden="true" />
							安全
						</TabsTrigger>
						<TabsTrigger value="actions" className="gap-1.5 whitespace-nowrap">
							<Play className="size-3.5" aria-hidden="true" />
							Actions
						</TabsTrigger>
						<TabsTrigger value="prs" className="gap-1.5 whitespace-nowrap">
							<GitPullRequest className="size-3.5" aria-hidden="true" />
							PRs
						</TabsTrigger>
						<TabsTrigger value="issues" className="gap-1.5 whitespace-nowrap">
							<CircleDot className="size-3.5" aria-hidden="true" />
							Issues
						</TabsTrigger>
						<TabsTrigger value="releases" className="gap-1.5 whitespace-nowrap">
							<Tag className="size-3.5" aria-hidden="true" />
							发布
						</TabsTrigger>
						<TabsTrigger value="traffic" className="gap-1.5 whitespace-nowrap">
							<Eye className="size-3.5" aria-hidden="true" />
							流量
						</TabsTrigger>
						<TabsTrigger value="languages" className="gap-1.5 whitespace-nowrap">
							<Code2 className="size-3.5" aria-hidden="true" />
							语言
						</TabsTrigger>
						<TabsTrigger value="contributors" className="gap-1.5 whitespace-nowrap">
							<Users className="size-3.5" aria-hidden="true" />
							贡献者
						</TabsTrigger>
					</TabsList>
				</ScrollArea>
				<TabsContent value="details">
					{snap ? (
						<div className="flex flex-col gap-4">
							<KpiRow>
								<Kpi icon={Star} label="Stars" value={formatCount(snap.stargazer_count)} />
								<Kpi icon={GitFork} label="Forks" value={formatCount(snap.fork_count)} />
								<Kpi icon={CircleDot} label="Issues" value={formatCount(snap.open_issue_count)} />
							</KpiRow>
							<SectionRule title="概览">
								<LayerCard padding="md">
									<DescriptionList columns={2}>
										<DescriptionList.Item term="默认分支">
											<Code>{snap.default_branch}</Code>
										</DescriptionList.Item>
										<DescriptionList.Item term="许可证">{snap.license ?? "—"}</DescriptionList.Item>
										<DescriptionList.Item term="最近推送">
											<span className="tabular-nums">{formatDate(snap.pushed_at)}</span>
										</DescriptionList.Item>
										<DescriptionList.Item term="归档">
											{snap.is_archived ? (
												<CandyBadge tone="orange">已归档</CandyBadge>
											) : (
												<CandyBadge tone="green">活跃</CandyBadge>
											)}
										</DescriptionList.Item>
										<DescriptionList.Item term="GitHub">
											<Link href={snap.url} target="_blank" rel="noreferrer">
												打开仓库
											</Link>
										</DescriptionList.Item>
									</DescriptionList>
								</LayerCard>
							</SectionRule>
						</div>
					) : null}
				</TabsContent>
				<TabsContent value="actions">
					{actions && "missing" in actions ? (
						<TabWell>
							<LayerCard.Empty
								icon={<Play />}
								title="没有快照"
								description="点击上方刷新，重新获取这个仓库的数据。"
							/>
						</TabWell>
					) : actions && actions.runs.length === 0 ? (
						<TabWell>
							<LayerCard.Empty
								icon={<Play />}
								title="还没有工作流记录"
								description="GitHub Actions 的运行状态与结果会显示在这里。"
							/>
						</TabWell>
					) : actions ? (
						<TabWell flush>
							<Table className="min-w-[680px] [&_th]:whitespace-nowrap">
								<TableHeader>
									<TableRow>
										<TableHead>名称</TableHead>
										<TableHead>状态</TableHead>
										<TableHead>结论</TableHead>
										<TableHead>事件</TableHead>
										<TableHead>分支</TableHead>
										<TableHead className={NUM_HEAD}>更新</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{actions.runs.map((run) => (
										<TableRow key={run.id}>
											<TableCell>
												<Link href={run.html_url} target="_blank" rel="noreferrer">
													{run.name}
												</Link>
											</TableCell>
											<TableCell>
												<CandyBadge tone="gray">{formatRunStatus(run.status)}</CandyBadge>
											</TableCell>
											<TableCell>
												<CandyBadge tone={conclusionBadgeVariant(run.conclusion)}>
													{formatConclusion(run.conclusion)}
												</CandyBadge>
											</TableCell>
											<TableCell>
												<CandyBadge tone="indigo">{run.event}</CandyBadge>
											</TableCell>
											<TableCell>
												<Code>{run.head_branch ?? "—"}</Code>
											</TableCell>
											<TableCell className={DATE_CELL}>{formatDate(run.updated_at)}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</TabWell>
					) : (
						<TableSkeleton label="加载 Actions" columns={6} rows={6} />
					)}
				</TabsContent>
				<TabsContent value="releases">
					{releases && "missing" in releases ? (
						<TabWell>
							<LayerCard.Empty
								icon={<Tag />}
								title="没有快照"
								description="点击上方刷新，重新获取这个仓库的数据。"
							/>
						</TabWell>
					) : releases && releases.releases.length === 0 ? (
						<TabWell>
							<LayerCard.Empty
								icon={<Tag />}
								title="还没有发布版本"
								description="仓库发布版本后，这里会显示标签与发布时间。"
							/>
						</TabWell>
					) : releases ? (
						<TabWell flush>
							<Table className="min-w-[680px] [&_th]:whitespace-nowrap">
								<TableHeader>
									<TableRow>
										<TableHead>标签</TableHead>
										<TableHead className={NUM_HEAD}>时间</TableHead>
										<TableHead>预发布</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{releases.releases.map((row) => (
										<TableRow key={row.id}>
											<TableCell>
												<Link href={row.html_url} target="_blank" rel="noreferrer">
													{row.tag_name}
												</Link>
											</TableCell>
											<TableCell className={DATE_CELL}>{formatDate(row.published_at)}</TableCell>
											<TableCell>
												{row.prerelease ? <CandyBadge tone="amber">预发布</CandyBadge> : "—"}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</TabWell>
					) : (
						<TableSkeleton label="加载 Release" columns={3} rows={6} />
					)}
				</TabsContent>
				<TabsContent value="security">
					{security && "missing" in security ? (
						<TabWell>
							<LayerCard.Empty
								icon={<ShieldAlert />}
								title="没有快照"
								description="点击上方刷新，重新获取这个仓库的数据。"
							/>
						</TabWell>
					) : security && securityUnavailable(security) ? (
						<TabWell>
							<LayerCard.Empty
								icon={<ShieldAlert />}
								title="无法查看安全数据"
								description="请在设置中检查当前账号的仓库访问权限。"
							/>
						</TabWell>
					) : security ? (
						<KpiRow>
							<Kpi icon={Bug} label="Dependabot" value={formatCount(security.dependabot_open)} />
							<Kpi
								icon={ShieldAlert}
								label="Code scanning"
								value={formatCount(security.code_scanning_open)}
							/>
						</KpiRow>
					) : null}
				</TabsContent>
				<TabsContent value="issues">
					{issues && "missing" in issues ? (
						<TabWell>
							<LayerCard.Empty
								icon={<CircleDot />}
								title="没有快照"
								description="点击上方刷新，重新获取这个仓库的数据。"
							/>
						</TabWell>
					) : issues && issues.issues.length === 0 ? (
						<TabWell>
							<LayerCard.Empty icon={<CircleDot />} title="没有 Issue" />
						</TabWell>
					) : issues ? (
						<TabWell flush>
							<Table className="min-w-[680px] [&_th]:whitespace-nowrap">
								<TableHeader>
									<TableRow>
										<TableHead>标题</TableHead>
										<TableHead>标签</TableHead>
										<TableHead>作者</TableHead>
										<TableHead className={NUM_HEAD}>评论</TableHead>
										<TableHead className={NUM_HEAD}>更新</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{issues.issues.map((row) => (
										<TableRow key={`${row.name_with_owner}#${row.number}`}>
											<TableCell>
												<Link
													href={row.url}
													target="_blank"
													rel="noreferrer"
													className="font-medium text-basalt-foreground [overflow-wrap:anywhere] hover:text-basalt-primary"
												>
													{row.title}
												</Link>
												<p className="mt-1 text-xs tabular-nums text-basalt-muted-foreground">
													#{row.number}
												</p>
											</TableCell>
											<TableCell>
												<LabelChips labels={row.labels} />
											</TableCell>
											<TableCell>
												<PersonCell login={row.author_login} />
											</TableCell>
											<TableCell className={NUM_CELL}>{formatCount(row.comments_count)}</TableCell>
											<TableCell className={DATE_CELL}>{formatDate(row.updated_at)}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</TabWell>
					) : (
						<TableSkeleton label="加载 Issues" columns={4} rows={6} />
					)}
				</TabsContent>
				<TabsContent value="prs">
					{pulls && "missing" in pulls ? (
						<TabWell>
							<LayerCard.Empty
								icon={<GitPullRequest />}
								title="没有快照"
								description="点击上方刷新，重新获取这个仓库的数据。"
							/>
						</TabWell>
					) : pulls && pulls.pull_requests.length === 0 ? (
						<TabWell>
							<LayerCard.Empty icon={<GitPullRequest />} title="没有 Pull Request" />
						</TabWell>
					) : pulls ? (
						<TabWell flush>
							<Table className="min-w-[680px] [&_th]:whitespace-nowrap">
								<TableHeader>
									<TableRow>
										<TableHead>标题</TableHead>
										<TableHead>作者</TableHead>
										<TableHead>状态</TableHead>
										<TableHead className={NUM_HEAD}>变更</TableHead>
										<TableHead className={NUM_HEAD}>更新</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{pulls.pull_requests.map((row) => {
										const churn = churnFilled(row.additions, row.deletions);
										return (
											<TableRow key={`${row.name_with_owner}#${row.number}`}>
												<TableCell>
													<Link
														href={row.url}
														target="_blank"
														rel="noreferrer"
														className="font-medium text-basalt-foreground [overflow-wrap:anywhere] hover:text-basalt-primary"
													>
														{row.title}
													</Link>
													<p className="mt-1 text-xs tabular-nums text-basalt-muted-foreground">
														#{row.number}
													</p>
												</TableCell>
												<TableCell>
													<PersonCell login={row.author_login} />
												</TableCell>
												<TableCell>
													<div className="flex flex-wrap gap-1">
														{row.is_draft ? <CandyBadge tone="purple">草稿</CandyBadge> : null}
														{row.review_decision ? (
															<CandyBadge tone={reviewBadgeVariant(row.review_decision)}>
																{formatReview(row.review_decision)}
															</CandyBadge>
														) : null}
														{!row.is_draft && !row.review_decision ? (
															<span className="text-basalt-muted-foreground">—</span>
														) : null}
													</div>
												</TableCell>
												<TableCell>
													<div className="flex items-center justify-end gap-2">
														<ChurnMeter
															adds={churn.adds}
															dels={churn.dels}
															label={`#${row.number} diff`}
														/>
														<span className={NUM_CELL}>
															<span className="text-basalt-info">
																+{formatCount(row.additions)}
															</span>
															<span className="text-basalt-muted-foreground">/</span>
															<span className="text-basalt-danger">
																−{formatCount(row.deletions)}
															</span>
														</span>
													</div>
												</TableCell>
												<TableCell className={DATE_CELL}>{formatDate(row.updated_at)}</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						</TabWell>
					) : (
						<TableSkeleton label="加载 Pull Requests" columns={7} rows={6} />
					)}
				</TabsContent>
				<TabsContent value="traffic">
					{traffic && "missing" in traffic ? (
						<TabWell>
							<LayerCard.Empty
								icon={<Eye />}
								title="没有快照"
								description="点击上方刷新，重新获取这个仓库的数据。"
							/>
						</TabWell>
					) : traffic && trafficForbidden(traffic) ? (
						<TabWell>
							<LayerCard.Empty
								icon={<Eye />}
								title="无法查看流量"
								description="流量数据需要当前账号拥有此仓库的推送权限。"
							/>
						</TabWell>
					) : traffic ? (
						<div className="flex flex-col gap-4">
							<KpiRow>
								<Kpi icon={Eye} label="浏览" value={formatCount(traffic.views.count)} />
								<Kpi icon={Users} label="独立访客" value={formatCount(traffic.views.uniques)} />
								<Kpi icon={Download} label="克隆" value={formatCount(traffic.clones.count)} />
								<Kpi
									icon={FolderDown}
									label="独立克隆"
									value={formatCount(traffic.clones.uniques)}
								/>
							</KpiRow>
							<ChartRow>
								<ChartBrick title="浏览趋势" description="最近 14 天的仓库页面访问">
									{traffic.views.points.length > 0 ? (
										<AreaChart
											data={trafficPoints(traffic.views.points)}
											ariaLabel="views"
											showAxes
											valueFormatter={formatCount}
											xValueFormatter={(value) => String(value).slice(5, 10)}
											summary={`${traffic.views.count} 次浏览，${traffic.views.uniques} 位独立访客`}
											className="h-56 w-full"
										/>
									) : (
										<ChartEmpty label="没有浏览数据" />
									)}
								</ChartBrick>
								<ChartBrick title="克隆趋势" description="最近 14 天的仓库克隆次数">
									{traffic.clones.points.length > 0 ? (
										<AreaChart
											data={trafficPoints(traffic.clones.points)}
											ariaLabel="clones"
											showAxes
											valueFormatter={formatCount}
											xValueFormatter={(value) => String(value).slice(5, 10)}
											summary={`${traffic.clones.count} 次克隆，${traffic.clones.uniques} 位独立克隆用户`}
											className="h-56 w-full"
										/>
									) : (
										<ChartEmpty label="没有克隆数据" />
									)}
								</ChartBrick>
							</ChartRow>
						</div>
					) : (
						<DetailSkeleton label="加载 Traffic" />
					)}
				</TabsContent>
				<TabsContent value="languages">
					{languages && "missing" in languages ? (
						<TabWell>
							<LayerCard.Empty
								icon={<Code2 />}
								title="没有快照"
								description="点击上方刷新，重新获取这个仓库的数据。"
							/>
						</TabWell>
					) : languages && Object.keys(languages.languages).length === 0 ? (
						<TabWell>
							<LayerCard.Empty
								icon={<Code2 />}
								title="还没有语言统计"
								description="仓库中有可统计的代码后，刷新即可查看语言分布。"
							/>
						</TabWell>
					) : languages ? (
						<ChartBrick title="语言分布" description="按仓库代码字节数统计">
							<DonutChart
								data={sortedLanguages(languages.languages)}
								ariaLabel="languages"
								className="h-56 w-full"
								showLegend
								valueFormatter={formatCount}
							/>
						</ChartBrick>
					) : (
						<ChartSkeleton label="加载语言" />
					)}
				</TabsContent>
				<TabsContent value="contributors">
					{contributors && "missing" in contributors ? (
						<TabWell>
							<LayerCard.Empty
								icon={<Users />}
								title="没有快照"
								description="点击上方刷新，重新获取这个仓库的数据。"
							/>
						</TabWell>
					) : contributors && contributors.contributors.length === 0 ? (
						<TabWell>
							<LayerCard.Empty
								icon={<Users />}
								title="还没有贡献记录"
								description="有提交记录的贡献者会显示在这里。"
							/>
						</TabWell>
					) : contributors ? (
						<TabWell flush>
							<Table className="min-w-[280px]" aria-label="贡献者">
								<TableHeader>
									<TableRow>
										<TableHead>贡献者</TableHead>
										<TableHead className={NUM_HEAD}>提交次数</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{contributors.contributors.map((row) => (
										<TableRow key={row.login}>
											<TableCell>
												<div className="flex min-w-0 items-center gap-3">
													<Avatar className="size-8 shrink-0">
														{row.avatar_url ? (
															<AvatarImage src={row.avatar_url} alt={row.login} />
														) : null}
														<AvatarFallback>{row.login.slice(0, 2)}</AvatarFallback>
													</Avatar>
													<Link
														href={row.html_url}
														target="_blank"
														rel="noreferrer"
														className="font-medium text-basalt-foreground [overflow-wrap:anywhere] hover:text-basalt-primary"
													>
														{row.login}
													</Link>
												</div>
											</TableCell>
											<TableCell className={NUM_CELL}>{formatCount(row.contributions)}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</TabWell>
					) : (
						<PeopleSkeleton label="加载贡献者" />
					)}
				</TabsContent>
			</Tabs>
		</div>
	);
}
