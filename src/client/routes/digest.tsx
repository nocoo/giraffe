import { Badge, Button, StatStrip, Toolbar } from "@nocoo/basalt";
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
import { useEffect, useMemo, useState } from "react";
import { formatDelta } from "../lib/format";
import { type DigestSnapshot, digestMarkdown, loadDigest } from "../viewmodels/digest";
import { requestRefresh } from "../viewmodels/refresh";

export function DigestPage() {
	const [snap, setSnap] = useState<DigestSnapshot | { missing: true } | null>(null);

	useEffect(() => {
		void loadDigest().then(setSnap);
	}, []);

	const markdown = useMemo(() => {
		if (!snap || "missing" in snap) {
			return "";
		}
		return digestMarkdown(snap);
	}, [snap]);

	if (snap && "missing" in snap) {
		return (
			<div className="flex flex-col gap-4">
				<PageHeader title="日报" />
				<Empty title="没有快照" description="先添加 PAT 或刷新。" />
				<Button
					type="button"
					onClick={() => {
						void requestRefresh(["repos"]).then(() => loadDigest().then(setSnap));
					}}
				>
					刷新
				</Button>
			</div>
		);
	}

	const missing = snap?.baseline_missing === true;

	return (
		<div className="flex flex-col gap-4">
			<PageHeader title="日报" />
			{snap?.truncated ? <Badge>已截断</Badge> : null}
			{missing ? <Badge>没有昨天的基线</Badge> : null}
			{snap ? (
				<StatStrip
					items={[
						{ label: "stars", value: formatDelta(snap.stars_delta, missing) },
						{ label: "forks", value: formatDelta(snap.forks_delta, missing) },
						{ label: "open issues", value: formatDelta(snap.open_issues_delta, missing) },
					]}
				/>
			) : null}
			<Toolbar aria-label="日报工具条">
				<Button
					type="button"
					variant="secondary"
					onClick={() => {
						void requestRefresh(["repos"]).then(() => loadDigest().then(setSnap));
					}}
				>
					刷新
				</Button>
			</Toolbar>
			{snap && snap.repos.length > 0 ? (
				<Table data-testid="digest-list">
					<TableHeader>
						<TableRow>
							<TableHead>仓</TableHead>
							<TableHead>stars</TableHead>
							<TableHead>forks</TableHead>
							<TableHead>issues</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{snap.repos.map((row) => (
							<TableRow key={row.name_with_owner}>
								<TableCell>{row.name_with_owner}</TableCell>
								<TableCell>{formatDelta(row.stars_delta, missing)}</TableCell>
								<TableCell>{formatDelta(row.forks_delta, missing)}</TableCell>
								<TableCell>{formatDelta(row.open_issues_delta, missing)}</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			) : (
				<Empty title="没有日报" />
			)}
			{markdown ? <ClipboardText text={markdown} /> : null}
		</div>
	);
}
