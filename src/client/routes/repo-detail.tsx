import {
	Avatar,
	AvatarFallback,
	AvatarImage,
	Badge,
	StatStrip,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	Toolbar,
	toast,
} from "@nocoo/basalt";
import { AreaChart } from "@nocoo/basalt/charts/area";
import { DonutChart } from "@nocoo/basalt/charts/donut";
import { Empty } from "@nocoo/basalt/components/empty";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@nocoo/basalt/components/table";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { RefreshButton } from "../components/layout/refresh-button";
import { catchLoad, missingTitle } from "../lib/error-ui";
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
		const missing = catchLoad(err, toast);
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
					await requestRefresh(repoKind(owner, name, "details"));
					if (cancelled) {
						return;
					}
					setSnap(await loadRepoTab<RepoDetails>(owner, name, "details"));
					return;
				}
				setSnap(next);
			})
			.catch((err: unknown) => {
				if (cancelled) {
					return;
				}
				const missing = catchLoad(err, toast);
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
			const missing = catchLoad(err, toast);
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
			<div className="flex flex-col gap-4">
				<PageHeader title="仓库" />
				<Empty title="无效仓库" />
			</div>
		);
	}

	if (snap && "missing" in snap) {
		return (
			<div className="flex flex-col gap-4">
				<PageHeader title={`${owner}/${name}`} />
				<Empty title={missingTitle(snap)} description="先添加 PAT 或刷新。" />
				<RefreshButton
					variant="default"
					run={() =>
						requestRefresh(repoKind(owner, name, "details")).then(() =>
							loadRepoTab<RepoDetails>(owner, name, "details").then(setSnap),
						)
					}
					onError={onLoadError}
				/>
			</div>
		);
	}

	if (!snap) {
		return (
			<div className="flex flex-col gap-4">
				<PageHeader title={`${owner}/${name}`} />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4" data-testid="repo-detail">
			<PageHeader title={`${owner}/${name}`} description={snap.description ?? name} />
			{(
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
												: contributors && !("missing" in contributors) && contributors.truncated
			) ? (
				<Badge>已截断</Badge>
			) : null}
			<Toolbar aria-label="仓库详情工具条">
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
						return requestRefresh(repoKind(owner, name, tab)).then(() => {
							if (mine !== gen.current) {
								return;
							}
							if (tab === "details") {
								return loadRepoTab<RepoDetails>(owner, name, "details").then(
									applyIfCurrent(setSnap),
								);
							}
							if (tab === "security") {
								return fetchTab<RepoSecurity>(owner, name, "security", refreshed.current).then(
									applyIfCurrent(setSecurity),
								);
							}
							if (tab === "actions") {
								return fetchTab<RepoActions>(owner, name, "actions", refreshed.current).then(
									applyIfCurrent(setActions),
								);
							}
							if (tab === "releases") {
								return fetchTab<RepoReleases>(owner, name, "releases", refreshed.current).then(
									applyIfCurrent(setReleases),
								);
							}
							if (tab === "issues") {
								return fetchTab<IssuesSnapshot>(owner, name, "issues", refreshed.current).then(
									applyIfCurrent(setIssues),
								);
							}
							if (tab === "prs") {
								return fetchTab<PullsSnapshot>(owner, name, "prs", refreshed.current).then(
									applyIfCurrent(setPulls),
								);
							}
							if (tab === "languages") {
								return fetchTab<RepoLanguages>(owner, name, "languages", refreshed.current).then(
									applyIfCurrent(setLanguages),
								);
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
						});
					}}
					onError={onLoadError}
				/>
			</Toolbar>
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
									{ label: "★", value: snap.stargazer_count },
									{ label: "fork", value: snap.fork_count },
									{ label: "issues", value: snap.open_issue_count },
								]}
							/>
							<p>默认分支 {snap.default_branch}</p>
							<p>license {snap.license ?? "—"}</p>
							<p>
								<a href={snap.url} target="_blank" rel="noreferrer">
									GitHub
								</a>
							</p>
						</div>
					) : null}
				</TabsContent>
				<TabsContent value="actions">
					{actions && "missing" in actions ? (
						<Empty title="没有快照" />
					) : actions && actions.runs.length === 0 ? (
						<Empty title="没有 workflow runs" />
					) : actions ? (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>name</TableHead>
									<TableHead>status</TableHead>
									<TableHead>conclusion</TableHead>
									<TableHead>event</TableHead>
									<TableHead>branch</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{actions.runs.map((run) => (
									<TableRow key={run.id}>
										<TableCell>
											<a href={run.html_url} target="_blank" rel="noreferrer">
												{run.name}
											</a>
										</TableCell>
										<TableCell>{run.status}</TableCell>
										<TableCell>
											<Badge>{run.conclusion ?? "—"}</Badge>
										</TableCell>
										<TableCell>{run.event}</TableCell>
										<TableCell>{run.head_branch ?? "—"}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					) : null}
				</TabsContent>
				<TabsContent value="releases">
					{releases && "missing" in releases ? (
						<Empty title="没有快照" />
					) : releases && releases.releases.length === 0 ? (
						<Empty title="没有 Release" />
					) : releases ? (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>tag</TableHead>
									<TableHead>时间</TableHead>
									<TableHead>prerelease</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{releases.releases.map((row) => (
									<TableRow key={row.id}>
										<TableCell>
											<a href={row.html_url} target="_blank" rel="noreferrer">
												{row.tag_name}
											</a>
										</TableCell>
										<TableCell>{row.published_at ?? "—"}</TableCell>
										<TableCell>{row.prerelease ? "是" : "否"}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					) : null}
				</TabsContent>
				<TabsContent value="security">
					{security && "missing" in security ? (
						<Empty title="没有快照" />
					) : security && securityUnavailable(security) ? (
						<Empty title="无权限" />
					) : security ? (
						<StatStrip
							items={[
								{ label: "Dependabot", value: security.dependabot_open },
								{ label: "code scanning", value: security.code_scanning_open },
							]}
						/>
					) : null}
				</TabsContent>
				<TabsContent value="issues">
					{issues && "missing" in issues ? (
						<Empty title="没有快照" />
					) : issues && issues.issues.length === 0 ? (
						<Empty title="没有 Issue" />
					) : issues ? (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>编号</TableHead>
									<TableHead>标题</TableHead>
									<TableHead>作者</TableHead>
									<TableHead>更新时间</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{issues.issues.map((row) => (
									<TableRow key={`${row.name_with_owner}#${row.number}`}>
										<TableCell>{row.number}</TableCell>
										<TableCell>
											<a href={row.url} target="_blank" rel="noreferrer">
												{row.title}
											</a>
										</TableCell>
										<TableCell>{row.author_login ?? "—"}</TableCell>
										<TableCell>{row.updated_at}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					) : null}
				</TabsContent>
				<TabsContent value="prs">
					{pulls && "missing" in pulls ? (
						<Empty title="没有快照" />
					) : pulls && pulls.pull_requests.length === 0 ? (
						<Empty title="没有 Pull Request" />
					) : pulls ? (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>编号</TableHead>
									<TableHead>标题</TableHead>
									<TableHead>作者</TableHead>
									<TableHead>draft</TableHead>
									<TableHead>review</TableHead>
									<TableHead>+add/−del</TableHead>
									<TableHead>更新时间</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{pulls.pull_requests.map((row) => (
									<TableRow key={`${row.name_with_owner}#${row.number}`}>
										<TableCell>{row.number}</TableCell>
										<TableCell>
											<a href={row.url} target="_blank" rel="noreferrer">
												{row.title}
											</a>
										</TableCell>
										<TableCell>{row.author_login ?? "—"}</TableCell>
										<TableCell>{row.is_draft ? "是" : "否"}</TableCell>
										<TableCell>{row.review_decision ?? "—"}</TableCell>
										<TableCell>
											+{row.additions}/−{row.deletions}
										</TableCell>
										<TableCell>{row.updated_at}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					) : null}
				</TabsContent>
				<TabsContent value="traffic">
					{traffic && "missing" in traffic ? (
						<Empty title="没有快照" />
					) : traffic && trafficForbidden(traffic) ? (
						<Empty title="无 Traffic 权限" />
					) : traffic ? (
						<div className="flex flex-col gap-4">
							<StatStrip
								items={[
									{ label: "views", value: traffic.views.count },
									{ label: "clones", value: traffic.clones.count },
								]}
							/>
							<AreaChart data={trafficPoints(traffic.views.points)} ariaLabel="views" />
						</div>
					) : null}
				</TabsContent>
				<TabsContent value="languages">
					{languages && "missing" in languages ? (
						<Empty title="没有快照" />
					) : languages && Object.keys(languages.languages).length === 0 ? (
						<Empty title="没有语言数据" />
					) : languages ? (
						<DonutChart data={sortedLanguages(languages.languages)} ariaLabel="languages" />
					) : null}
				</TabsContent>
				<TabsContent value="contributors">
					{contributors && "missing" in contributors ? (
						<Empty title="没有快照" />
					) : contributors && contributors.contributors.length === 0 ? (
						<Empty title="没有贡献者" />
					) : contributors ? (
						<ul className="flex flex-col gap-3">
							{contributors.contributors.map((row) => (
								<li key={row.login} className="flex items-center gap-3">
									<Avatar>
										<AvatarImage src={row.avatar_url} alt={row.login} />
										<AvatarFallback>{row.login.slice(0, 2)}</AvatarFallback>
									</Avatar>
									<a href={row.html_url} target="_blank" rel="noreferrer">
										{row.login}
									</a>
									<span>{row.contributions}</span>
								</li>
							))}
						</ul>
					) : null}
				</TabsContent>
			</Tabs>
		</div>
	);
}
