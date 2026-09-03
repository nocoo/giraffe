import { Badge, Input, Link, toast } from "@nocoo/basalt";
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
import { GitPullRequest } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { RefreshButton } from "../components/layout/refresh-button";
import { catchLoad, missingTitle } from "../lib/error-ui";
import { formatDate, formatReview } from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import { filterPulls, loadPulls, type PullsSnapshot } from "../viewmodels/pulls";
import { requestRefresh } from "../viewmodels/refresh";

export function PullsPage() {
	const [query, setQuery] = useState("");
	const [snap, setSnap] = useState<PullsSnapshot | { missing: true } | null>(null);

	function onLoadError(err: unknown): void {
		const missing = catchLoad(err, toast);
		if (missing) {
			setSnap(missing);
		}
	}

	useEffect(() => {
		void loadPulls()
			.then(setSnap)
			.catch((err: unknown) => {
				const missing = catchLoad(err, toast);
				if (missing) {
					setSnap(missing);
				}
			});
	}, []);

	const rows = useMemo(() => {
		if (!snap || "missing" in snap) {
			return [];
		}
		return filterPulls(snap.pull_requests, query);
	}, [snap, query]);

	if (snap && "missing" in snap) {
		return (
			<div className="flex flex-col gap-6">
				<PageHeader title="Pull Requests" description={PAGE_DESCRIPTIONS["/pulls"]} />
				<LayerCard>
					<LayerCard.Primary className="flex flex-col gap-4">
						<LayerCard.Empty
							icon={<GitPullRequest />}
							title={missingTitle(snap)}
							description="先添加 PAT 或刷新。"
						/>
						<RefreshButton
							variant="default"
							run={() => requestRefresh(["prs"]).then(() => loadPulls().then(setSnap))}
							onError={onLoadError}
						/>
					</LayerCard.Primary>
				</LayerCard>
			</div>
		);
	}

	if (!snap) {
		return (
			<div className="flex flex-col gap-6">
				<PageHeader title="Pull Requests" description={PAGE_DESCRIPTIONS["/pulls"]} />
				<LayerCard>
					<LayerCard.Primary>
						<LayerCard.Loading label="加载 Pull Requests" />
					</LayerCard.Primary>
				</LayerCard>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				title="Pull Requests"
				description={PAGE_DESCRIPTIONS["/pulls"]}
				actions={snap.truncated ? <Badge variant="warning">已截断</Badge> : null}
			/>
			<LayerCard>
				<LayerCard.Header>
					<div className="flex w-full flex-col gap-3 md:flex-row md:items-center md:justify-between">
						<Input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="搜索仓库或标题"
							aria-label="搜索 Pull Requests"
							className="md:max-w-sm"
						/>
						<RefreshButton
							run={() => requestRefresh(["prs"]).then(() => loadPulls().then(setSnap))}
							onError={onLoadError}
						/>
					</div>
				</LayerCard.Header>
				<LayerCard.Primary className={rows.length === 0 ? undefined : "p-0"}>
					{rows.length === 0 ? (
						<LayerCard.Empty icon={<GitPullRequest />} title="没有 Pull Request" />
					) : (
						<Table data-testid="pr-list">
							<TableHeader>
								<TableRow>
									<TableHead>仓库</TableHead>
									<TableHead>编号</TableHead>
									<TableHead>标题</TableHead>
									<TableHead>作者</TableHead>
									<TableHead>草稿</TableHead>
									<TableHead>审查</TableHead>
									<TableHead>+/−</TableHead>
									<TableHead>更新</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((row) => (
									<TableRow key={`${row.name_with_owner}#${row.number}`}>
										<TableCell className="text-basalt-muted-foreground">
											{row.name_with_owner}
										</TableCell>
										<TableCell className="tabular-nums">#{row.number}</TableCell>
										<TableCell>
											<Link href={row.url} target="_blank" rel="noreferrer">
												{row.title}
											</Link>
										</TableCell>
										<TableCell>{row.author_login ?? "—"}</TableCell>
										<TableCell>
											{row.is_draft ? <Badge variant="secondary">草稿</Badge> : "—"}
										</TableCell>
										<TableCell>{formatReview(row.review_decision)}</TableCell>
										<TableCell className="tabular-nums">
											<span className="text-basalt-info">+{row.additions}</span>
											<span className="text-basalt-muted-foreground">/</span>
											<span className="text-basalt-danger">−{row.deletions}</span>
										</TableCell>
										<TableCell className="text-basalt-muted-foreground">
											{formatDate(row.updated_at)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</LayerCard.Primary>
			</LayerCard>
		</div>
	);
}
