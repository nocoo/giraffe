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
import { Empty } from "@nocoo/basalt/components/empty";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { requestRefresh } from "../viewmodels/refresh";
import {
	isValidRepoPart,
	loadRepoTab,
	type RepoDetails,
	repoKind,
} from "../viewmodels/repo-detail";

export function RepoDetailPage() {
	const params = useParams();
	const owner = params.owner ?? "";
	const name = params.name ?? "";
	const valid = isValidRepoPart(owner) && isValidRepoPart(name);
	const [snap, setSnap] = useState<RepoDetails | { missing: true } | { invalid: true } | null>(
		null,
	);
	const refreshed = useRef(false);

	useEffect(() => {
		if (!valid) {
			setSnap({ invalid: true });
			return;
		}
		void loadRepoTab<RepoDetails>(owner, name, "details").then(async (next) => {
			if ("missing" in next && !refreshed.current) {
				refreshed.current = true;
				await requestRefresh(repoKind(owner, name, "details"));
				setSnap(await loadRepoTab<RepoDetails>(owner, name, "details"));
				return;
			}
			setSnap(next);
		});
	}, [owner, name, valid]);

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
						void requestRefresh(repoKind(owner, name, "details")).then(() =>
							loadRepoTab<RepoDetails>(owner, name, "details").then(setSnap),
						);
					}}
				>
					刷新
				</Button>
			</Toolbar>
			<Tabs defaultValue="details">
				<TabsList>
					<TabsTrigger value="details">概览</TabsTrigger>
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
			</Tabs>
		</div>
	);
}
