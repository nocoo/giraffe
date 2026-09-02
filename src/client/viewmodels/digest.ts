import { formatDelta } from "../lib/format";
import { loadKind } from "./snapshot";

export type DigestRepo = {
	name_with_owner: string;
	stars_delta: number | null;
	forks_delta: number | null;
	open_issues_delta: number | null;
};

export type DigestSnapshot = {
	account_id: string;
	fetched_at: string;
	truncated: boolean;
	day: string;
	baseline_missing: boolean;
	stars_delta: number | null;
	forks_delta: number | null;
	open_issues_delta: number | null;
	repos: DigestRepo[];
};

export function digestMarkdown(snap: DigestSnapshot): string {
	const missing = snap.baseline_missing;
	const lines = [`# ${snap.day}`, ""];
	if (missing) {
		lines.push("没有昨天的基线", "");
	}
	lines.push("| 仓 | stars | forks | issues |", "| --- | --- | --- | --- |");
	for (const row of snap.repos) {
		lines.push(
			`| ${row.name_with_owner} | ${formatDelta(row.stars_delta, missing)} | ${formatDelta(row.forks_delta, missing)} | ${formatDelta(row.open_issues_delta, missing)} |`,
		);
	}
	lines.push(
		"",
		`合计 stars ${formatDelta(snap.stars_delta, missing)} / forks ${formatDelta(snap.forks_delta, missing)} / issues ${formatDelta(snap.open_issues_delta, missing)}`,
	);
	return lines.join("\n");
}

export async function loadDigest(): Promise<DigestSnapshot | { missing: true }> {
	return loadKind<DigestSnapshot>("digest");
}
