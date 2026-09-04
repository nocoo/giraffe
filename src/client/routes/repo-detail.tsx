import {
	Avatar,
	AvatarFallback,
	AvatarImage,
	Badge,
	Link,
	StatStrip,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	toast,
} from "@nocoo/basalt";
import { AreaChart } from "@nocoo/basalt/charts/area";
import { DonutChart } from "@nocoo/basalt/charts/donut";
import { DescriptionList } from "@nocoo/basalt/components/description-list";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@nocoo/basalt/components/table";
import { Box, GitPullRequest } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
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
			<LayerCard.Well {...(flush ? { className: "p-0" } : {})}>{children}</LayerCard.Well>
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
			}
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
				<PageHeader title={`${owner}/${name}`} />
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
				<PageHeader title={`${owner}/${name}`} />
				<DetailSkeleton label="加载仓库" />
			</div>
		);
	}

	const truncated =
		tab === "details"
			? snap.truncated
			: tab === "security"
				? security && !("missing" in security) && security.truncated
				: tab === "traffic"
					? traffic && !("missing" in traffic) && traffic.truncated
					: tab === "actions"
						? actions && !("missing" in actions) && actions.truncated
						: tab === "releases"
							? releases && !("missing" in releases) && releases.truncated
							: tab === "issues"
								? issues && !("missing" in issues) && issues.truncated
								: tab === "prs"
									? pulls && !("missing" in pulls) && pulls.truncated
									: tab === "languages"
										? languages && !("missing" in languages) && languages.truncated
										: contributors && !("missing" in contributors) && contributors.truncated;

	return (
		<div className="space-y-8" data-testid="repo-detail">
			<PageHeader
				title={`${owner}/${name}`}
				description={snap.description ?? name}
				actions={
					<>
						{truncated ? <Badge variant="warning">已截断</Badge> : null}
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
			<Tabs value={tab} onValueChange={(value) => setTab(value as RepoTab)}>
				<TabsList>
					<TabsTrigger value="details">概览</TabsTrigger>
					<TabsTrigger value="security">Security</TabsTrigger>
					<TabsTrigger value="actions">Actions</TabsTrigger>
					<TabsTrigger value="prs">PRs</TabsTrigger>
					<TabsTrigger value="issues">Issues</TabsTrigger>
					<TabsTrigger value="releases">Releases</TabsTrigger>
					<TabsTrigger value="traffic">Traffic</TabsTrigger>
					<TabsTrigger value="languages">Languages</TabsTrigger>
					<TabsTrigger value="contributors">Contributors</TabsTrigger>
				</TabsList>
				<TabsContent value="details">
					{snap ? (
						<div className="flex flex-col gap-4">
							<StatStrip
								items={[
									{ label: "Stars", value: formatCount(snap.stargazer_count) },
									{ label: "Forks", value: formatCount(snap.fork_count) },
									{ label: "Issues", value: formatCount(snap.open_issue_count) },
								]}
							/>
							<LayerCard>
								<LayerCard.Header>概览</LayerCard.Header>
								<LayerCard.Body>
									<DescriptionList columns={2}>
										<DescriptionList.Item term="默认分支">
											{snap.default_branch}
										</DescriptionList.Item>
										<DescriptionList.Item term="许可证">{snap.license ?? "—"}</DescriptionList.Item>
										<DescriptionList.Item term="最近推送">
											<span className="tabular-nums">{formatDate(snap.pushed_at)}</span>
										</DescriptionList.Item>
										<DescriptionList.Item term="归档">
											{snap.is_archived ? (
												<Badge variant="secondary">已归档</Badge>
											) : (
												<Badge variant="outline">活跃</Badge>
											)}
										</DescriptionList.Item>
										<DescriptionList.Item term="GitHub">
											<Link href={snap.url} target="_blank" rel="noreferrer">
												打开仓库
											</Link>
										</DescriptionList.Item>
									</DescriptionList>
								</LayerCard.Body>
							</LayerCard>
						</div>
					) : null}
				</TabsContent>
				<TabsContent value="actions">
					{actions && "missing" in actions ? (
						<TabWell>
							<LayerCard.Empty title="没有快照" />
						</TabWell>
					) : actions && actions.runs.length === 0 ? (
						<TabWell>
							<LayerCard.Empty title="没有 workflow runs" />
						</TabWell>
					) : actions ? (
						<TabWell flush>
							<Table>
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
												<Badge variant="outline">{formatRunStatus(run.status)}</Badge>
											</TableCell>
											<TableCell>
												<Badge
													variant={
														run.conclusion === "success"
															? "success"
															: run.conclusion === "failure"
																? "error"
																: "secondary"
													}
												>
													{formatConclusion(run.conclusion)}
												</Badge>
											</TableCell>
											<TableCell>
												<Badge variant="outline">{run.event}</Badge>
											</TableCell>
											<TableCell>{run.head_branch ?? "—"}</TableCell>
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
							<LayerCard.Empty title="没有快照" />
						</TabWell>
					) : releases && releases.releases.length === 0 ? (
						<TabWell>
							<LayerCard.Empty title="没有 Release" />
						</TabWell>
					) : releases ? (
						<TabWell flush>
							<Table>
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
												{row.prerelease ? <Badge variant="secondary">预发布</Badge> : "—"}
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
							<LayerCard.Empty title="没有快照" />
						</TabWell>
					) : security && securityUnavailable(security) ? (
						<TabWell>
							<LayerCard.Empty title="无权限" />
						</TabWell>
					) : security ? (
						<StatStrip
							items={[
								{ label: "Dependabot", value: formatCount(security.dependabot_open) },
								{ label: "code scanning", value: formatCount(security.code_scanning_open) },
							]}
						/>
					) : null}
				</TabsContent>
				<TabsContent value="issues">
					{issues && "missing" in issues ? (
						<TabWell>
							<LayerCard.Empty title="没有快照" />
						</TabWell>
					) : issues && issues.issues.length === 0 ? (
						<TabWell>
							<LayerCard.Empty title="没有 Issue" />
						</TabWell>
					) : issues ? (
						<TabWell flush>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead className={NUM_HEAD}>编号</TableHead>
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
											<TableCell className={NUM_CELL}>#{row.number}</TableCell>
											<TableCell>
												<Link href={row.url} target="_blank" rel="noreferrer">
													{row.title}
												</Link>
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
							<LayerCard.Empty icon={<GitPullRequest />} title="没有快照" />
						</TabWell>
					) : pulls && pulls.pull_requests.length === 0 ? (
						<TabWell>
							<LayerCard.Empty icon={<GitPullRequest />} title="没有 Pull Request" />
						</TabWell>
					) : pulls ? (
						<TabWell flush>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead className={NUM_HEAD}>编号</TableHead>
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
												<TableCell className={NUM_CELL}>#{row.number}</TableCell>
												<TableCell>
													<Link href={row.url} target="_blank" rel="noreferrer">
														{row.title}
													</Link>
												</TableCell>
												<TableCell>
													<PersonCell login={row.author_login} />
												</TableCell>
												<TableCell>
													<div className="flex flex-wrap gap-1">
														{row.is_draft ? <Badge variant="purple">草稿</Badge> : null}
														{row.review_decision ? (
															<Badge variant={reviewBadgeVariant(row.review_decision)}>
																{formatReview(row.review_decision)}
															</Badge>
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
							<LayerCard.Empty title="没有快照" />
						</TabWell>
					) : traffic && trafficForbidden(traffic) ? (
						<TabWell>
							<LayerCard.Empty title="无 Traffic 权限" />
						</TabWell>
					) : traffic ? (
						<div className="flex flex-col gap-4">
							<StatStrip
								items={[
									{ label: "浏览", value: formatCount(traffic.views.count) },
									{ label: "克隆", value: formatCount(traffic.clones.count) },
								]}
							/>
							<TabWell>
								<AreaChart data={trafficPoints(traffic.views.points)} ariaLabel="views" />
							</TabWell>
						</div>
					) : (
						<DetailSkeleton label="加载 Traffic" />
					)}
				</TabsContent>
				<TabsContent value="languages">
					{languages && "missing" in languages ? (
						<TabWell>
							<LayerCard.Empty title="没有快照" />
						</TabWell>
					) : languages && Object.keys(languages.languages).length === 0 ? (
						<TabWell>
							<LayerCard.Empty title="没有语言数据" />
						</TabWell>
					) : languages ? (
						<TabWell>
							<DonutChart data={sortedLanguages(languages.languages)} ariaLabel="languages" />
						</TabWell>
					) : (
						<ChartSkeleton label="加载语言" />
					)}
				</TabsContent>
				<TabsContent value="contributors">
					{contributors && "missing" in contributors ? (
						<TabWell>
							<LayerCard.Empty title="没有快照" />
						</TabWell>
					) : contributors && contributors.contributors.length === 0 ? (
						<TabWell>
							<LayerCard.Empty title="没有贡献者" />
						</TabWell>
					) : contributors ? (
						<TabWell>
							<ul className="flex flex-col gap-3">
								{contributors.contributors.map((row) => (
									<li key={row.login} className="flex items-center gap-3">
										<Avatar>
											<AvatarImage src={row.avatar_url} alt={row.login} />
											<AvatarFallback>{row.login.slice(0, 2)}</AvatarFallback>
										</Avatar>
										<Link href={row.html_url} target="_blank" rel="noreferrer">
											{row.login}
										</Link>
										<span className="ml-auto text-sm text-basalt-muted-foreground tabular-nums">
											{formatCount(row.contributions)} 次
										</span>
									</li>
								))}
							</ul>
						</TabWell>
					) : (
						<PeopleSkeleton label="加载贡献者" />
					)}
				</TabsContent>
			</Tabs>
		</div>
	);
}
