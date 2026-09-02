import { Badge, Input, Link, toast } from "@nocoo/basalt";
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
import { CircleDot } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { RefreshButton } from "../components/layout/refresh-button";
import { catchLoad, missingTitle } from "../lib/error-ui";
import { formatDate } from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import { filterIssues, type IssuesSnapshot, loadIssues } from "../viewmodels/issues";
import { requestRefresh } from "../viewmodels/refresh";

export function IssuesPage() {
	const [query, setQuery] = useState("");
	const [snap, setSnap] = useState<IssuesSnapshot | { missing: true } | null>(null);

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
			<div className="flex flex-col gap-6">
				<PageHeader title="Issues" description={PAGE_DESCRIPTIONS["/issues"]} />
				<Empty icon={<CircleDot />} title={missingTitle(snap)} description="先添加 PAT 或刷新。" />
				<RefreshButton
					variant="default"
					run={() => requestRefresh(["issues"]).then(() => loadIssues().then(setSnap))}
					onError={onLoadError}
				/>
			</div>
		);
	}

	if (!snap) {
		return (
			<div className="flex flex-col gap-6">
				<PageHeader title="Issues" description={PAGE_DESCRIPTIONS["/issues"]} />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				title="Issues"
				description={PAGE_DESCRIPTIONS["/issues"]}
				actions={snap.truncated ? <Badge variant="warning">已截断</Badge> : null}
			/>
			<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
				<Input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="搜索仓库或标题"
					aria-label="搜索 Issues"
					className="md:max-w-sm"
				/>
				<RefreshButton
					run={() => requestRefresh(["issues"]).then(() => loadIssues().then(setSnap))}
					onError={onLoadError}
				/>
			</div>
			{rows.length === 0 ? (
				<Empty icon={<CircleDot />} title="没有 Issue" />
			) : (
				<Table data-testid="issue-list">
					<TableHeader>
						<TableRow>
							<TableHead>仓库</TableHead>
							<TableHead>编号</TableHead>
							<TableHead>标题</TableHead>
							<TableHead>作者</TableHead>
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
								<TableCell className="text-basalt-muted-foreground">
									{formatDate(row.updated_at)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</div>
	);
}
