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
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { requestRefresh } from "../viewmodels/refresh";
import {
	isValidRepoPart,
	loadRepoTab,
	type RepoDetails,
	type RepoSecurity,
	type RepoTab,
	type RepoTraffic,
	repoKind,
	securityUnavailable,
	trafficForbidden,
	trafficPoints,
} from "../viewmodels/repo-detail";

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
			void loadRepoTab<RepoSecurity>(owner, name, "security").then(async (next) => {
				if ("invalid" in next) {
					return;
				}
				if ("missing" in next && !refreshed.current.has("security")) {
					refreshed.current.add("security");
					await requestRefresh(repoKind(owner, name, "security"));
					const again = await loadRepoTab<RepoSecurity>(owner, name, "security");
					setSecurity("invalid" in again ? { missing: true } : again);
					return;
				}
				setSecurity("invalid" in next ? { missing: true } : next);
			});
		}
		if (tab === "traffic") {
			void loadRepoTab<RepoTraffic>(owner, name, "traffic").then(async (next) => {
				if ("invalid" in next) {
					return;
				}
				if ("missing" in next && !refreshed.current.has("traffic")) {
					refreshed.current.add("traffic");
					await requestRefresh(repoKind(owner, name, "traffic"));
					const again = await loadRepoTab<RepoTraffic>(owner, name, "traffic");
					setTraffic("invalid" in again ? { missing: true } : again);
					return;
				}
				setTraffic("invalid" in next ? { missing: true } : next);
			});
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
								return loadRepoTab<RepoSecurity>(owner, name, "security").then((next) => {
									setSecurity("invalid" in next ? { missing: true } : next);
								});
							}
							return loadRepoTab<RepoTraffic>(owner, name, "traffic").then((next) => {
								setTraffic("invalid" in next ? { missing: true } : next);
							});
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
