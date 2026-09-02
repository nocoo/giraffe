import { Badge, Button, Input, Toolbar, toast } from "@nocoo/basalt";
import { Empty } from "@nocoo/basalt/components/empty";
import { Loader } from "@nocoo/basalt/components/loader";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@nocoo/basalt/components/table";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { catchLoad, missingTitle } from "../lib/error-ui";
import { filterIssues, type IssuesSnapshot, loadIssues } from "../viewmodels/issues";
import { refreshInFlight, requestRefresh, subscribeRefresh } from "../viewmodels/refresh";

export function IssuesPage() {
	const [query, setQuery] = useState("");
	const [snap, setSnap] = useState<IssuesSnapshot | { missing: true } | null>(null);
	const busy = useSyncExternalStore(subscribeRefresh, refreshInFlight, refreshInFlight);

	function onLoadError(err: unknown): void {
		const missing = catchLoad(err, toast);
		if (missing) {
			setSnap(missing);
		}
	}

	useEffect(() => {
		void loadIssues()
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
		return filterIssues(snap.issues, query);
	}, [snap, query]);

	if (snap && "missing" in snap) {
		return (
			<div className="flex flex-col gap-4">
				<PageHeader title="Issues" />
				<Empty title={missingTitle(snap)} description="先添加 PAT 或刷新。" />
				<Button
					type="button"
					disabled={busy}
					onClick={() => {
						void requestRefresh(["issues"])
							.then(() => {
								toast("已刷新");
								return loadIssues().then(setSnap);
							})
							.catch(onLoadError);
					}}
				>
					{busy ? <Loader size={14} /> : null}
					刷新
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<PageHeader title="Issues" />
			{snap?.truncated ? <Badge>已截断</Badge> : null}
			<Toolbar aria-label="Issues 工具条">
				<Input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="搜索仓库或标题"
					aria-label="搜索 Issues"
				/>
				<Button
					type="button"
					variant="secondary"
					disabled={busy}
					onClick={() => {
						void requestRefresh(["issues"])
							.then(() => {
								toast("已刷新");
								return loadIssues().then(setSnap);
							})
							.catch(onLoadError);
					}}
				>
					{busy ? <Loader size={14} /> : null}
					刷新
				</Button>
			</Toolbar>
			{rows.length === 0 ? (
				<Empty title="没有 Issue" />
			) : (
				<Table data-testid="issue-list">
					<TableHeader>
						<TableRow>
							<TableHead>仓</TableHead>
							<TableHead>编号</TableHead>
							<TableHead>标题</TableHead>
							<TableHead>作者</TableHead>
							<TableHead>更新时间</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row) => (
							<TableRow key={`${row.name_with_owner}#${row.number}`}>
								<TableCell>{row.name_with_owner}</TableCell>
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
			)}
		</div>
	);
}
