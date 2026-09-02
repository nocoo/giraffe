import { Badge, Link, StatStrip, toast } from "@nocoo/basalt";
import { ClipboardText } from "@nocoo/basalt/components/clipboard-text";
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
import { Newspaper } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { RefreshButton } from "../components/layout/refresh-button";
import { catchLoad, missingTitle } from "../lib/error-ui";
import { formatDelta } from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import { type DigestSnapshot, digestMarkdown, loadDigest } from "../viewmodels/digest";
import { requestRefresh } from "../viewmodels/refresh";

export function DigestPage() {
	const [snap, setSnap] = useState<DigestSnapshot | { missing: true } | null>(null);

	function onLoadError(err: unknown): void {
		const missing = catchLoad(err, toast);
		if (missing) {
			setSnap(missing);
		}
	}

	useEffect(() => {
		void loadDigest()
			.then(setSnap)
			.catch((err: unknown) => {
				const missing = catchLoad(err, toast);
				if (missing) {
					setSnap(missing);
				}
			});
	}, []);

	const markdown = useMemo(() => {
		if (!snap || "missing" in snap) {
			return "";
		}
		return digestMarkdown(snap);
	}, [snap]);

	if (snap && "missing" in snap) {
		return (
			<div className="flex flex-col gap-6">
				<PageHeader title="日报" description={PAGE_DESCRIPTIONS["/digest"]} />
				<Empty icon={<Newspaper />} title={missingTitle(snap)} description="先添加 PAT 或刷新。" />
				<RefreshButton
					variant="default"
					run={() => requestRefresh(["repos"]).then(() => loadDigest().then(setSnap))}
					onError={onLoadError}
				/>
			</div>
		);
	}

	if (!snap) {
		return (
			<div className="flex flex-col gap-6">
				<PageHeader title="日报" description={PAGE_DESCRIPTIONS["/digest"]} />
			</div>
		);
	}

	const missing = snap.baseline_missing === true;

	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				title="日报"
				description={PAGE_DESCRIPTIONS["/digest"]}
				actions={
					<>
						{snap.truncated ? <Badge variant="warning">已截断</Badge> : null}
						{missing ? <Badge variant="secondary">没有昨天的基线</Badge> : null}
						<RefreshButton
							run={() => requestRefresh(["repos"]).then(() => loadDigest().then(setSnap))}
							onError={onLoadError}
						/>
					</>
				}
			/>
			<StatStrip
				items={[
					{ label: "Stars 变化", value: formatDelta(snap.stars_delta, missing) },
					{ label: "Forks 变化", value: formatDelta(snap.forks_delta, missing) },
					{ label: "打开 Issues 变化", value: formatDelta(snap.open_issues_delta, missing) },
				]}
			/>
			{snap.repos.length > 0 ? (
				<Table data-testid="digest-list">
					<TableHeader>
						<TableRow>
							<TableHead>仓库</TableHead>
							<TableHead>Stars</TableHead>
							<TableHead>Forks</TableHead>
							<TableHead>Issues</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{snap.repos.map((row) => (
							<TableRow key={row.name_with_owner}>
								<TableCell>
									<Link href={`/repos/${row.name_with_owner}`}>{row.name_with_owner}</Link>
								</TableCell>
								<TableCell className="tabular-nums">
									{formatDelta(row.stars_delta, missing)}
								</TableCell>
								<TableCell className="tabular-nums">
									{formatDelta(row.forks_delta, missing)}
								</TableCell>
								<TableCell className="tabular-nums">
									{formatDelta(row.open_issues_delta, missing)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			) : (
				<Empty icon={<Newspaper />} title="没有日报" />
			)}
			{markdown ? <ClipboardText text={markdown} copyText="复制 Markdown" /> : null}
		</div>
	);
}
