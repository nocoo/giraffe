import {
	Badge,
	Button,
	StatStrip,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	Toolbar,
} from "@nocoo/basalt";
import { AreaChart } from "@nocoo/basalt/charts/area";
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
import { requestRefresh } from "../viewmodels/refresh";
import {
	isValidRepoPart,
	loadRepoTab,
	type RepoActions,
	type RepoDetails,
	type RepoReleases,
	type RepoSecurity,
	type RepoTab,
	type RepoTraffic,
	repoKind,
	securityUnavailable,
	trafficForbidden,
	trafficPoints,
} from "../viewmodels/repo-detail";

async function fetchTab<T extends object>(
	owner: string,
	name: string,
	tab: RepoTab,
	auto: Set<string>,
): Promise<T | { missing: true }> {
	const first = await loadRepoTab<T>(owner, name, tab);
	if ("invalid" in first) {
		return { missing: true };
	}
	if ("missing" in first && !auto.has(tab)) {
		auto.add(tab);
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
	const refreshed = useRef(new Set<string>());

	useEffect(() => {
		if (!valid) {
			setSnap({ invalid: true });
			return;
		}
		void loadRepoTab<RepoDetails>(owner, name, "details").then(async (next) => {
			if ("missing" in next && !refreshed.current.has("details")) {
				refreshed.current.add("details");
				await requestRefresh(repoKind(owner, name, "details"));
				setSnap(await loadRepoTab<RepoDetails>(owner, name, "details"));
				return;
			}
			setSnap(next);
		});
	}, [owner, name, valid]);

	useEffect(() => {
		if (!valid) {
			return;
		}
		if (tab === "security") {
			void fetchTab<RepoSecurity>(owner, name, "security", refreshed.current).then(setSecurity);
		}
		if (tab === "traffic") {
			void fetchTab<RepoTraffic>(owner, name, "traffic", refreshed.current).then(setTraffic);
		}
		if (tab === "actions") {
			void fetchTab<RepoActions>(owner, name, "actions", refreshed.current).then(setActions);
		}
		if (tab === "releases") {
			void fetchTab<RepoReleases>(owner, name, "releases", refreshed.current).then(setReleases);
		}
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
				<Empty title="没有快照" description="先添加 PAT 或刷新。" />
				<Button
					type="button"
					onClick={() => {
						void requestRefresh(repoKind(owner, name, "details")).then(() =>
							loadRepoTab<RepoDetails>(owner, name, "details").then(setSnap),
						);
					}}
				>
					刷新
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4" data-testid="repo-detail">
			<PageHeader title={`${owner}/${name}`} description={snap?.description ?? name} />
			{snap?.truncated ? <Badge>已截断</Badge> : null}
			<Toolbar aria-label="仓库详情工具条">
				<Button
					type="button"
					variant="secondary"
					onClick={() => {
						void requestRefresh(repoKind(owner, name, tab)).then(() => {
							if (tab === "details") {
								return loadRepoTab<RepoDetails>(owner, name, "details").then(setSnap);
							}
							if (tab === "security") {
								return fetchTab<RepoSecurity>(owner, name, "security", refreshed.current).then(
									setSecurity,
								);
							}
							if (tab === "actions") {
								return fetchTab<RepoActions>(owner, name, "actions", refreshed.current).then(
									setActions,
								);
							}
							if (tab === "releases") {
								return fetchTab<RepoReleases>(owner, name, "releases", refreshed.current).then(
									setReleases,
								);
							}
							return fetchTab<RepoTraffic>(owner, name, "traffic", refreshed.current).then(
								setTraffic,
							);
						});
					}}
				>
					刷新
				</Button>
			</Toolbar>
			<Tabs value={tab} onValueChange={(value) => setTab(value as RepoTab)}>
				<TabsList>
					<TabsTrigger value="details">概览</TabsTrigger>
					<TabsTrigger value="security">Security</TabsTrigger>
					<TabsTrigger value="actions">Actions</TabsTrigger>
					<TabsTrigger value="releases">Releases</TabsTrigger>
					<TabsTrigger value="traffic">Traffic</TabsTrigger>
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
			</Tabs>
		</div>
	);
}
