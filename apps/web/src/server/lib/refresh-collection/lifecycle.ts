import type { FactoryEvent } from "../../../lib/factory-types";
import type { RefreshDay } from "../../../lib/refresh-types";
import { event, type Node, nodes, object, text } from "./model";

const page = `pageInfo { hasNextPage endCursor }`;

const toGithubSecond = (iso: string) => iso.replace(/\.\d{3}Z$/, "Z");

export function lifecycleSearchRange(days: RefreshDay[]): string | null {
	const first = days[0];
	const last = days.at(-1);
	if (!first || !last) return null;
	const untilExclusive = new Date(Date.parse(last.until) - 1).toISOString();
	return `${toGithubSecond(first.since)}..${toGithubSecond(untilExclusive)}`;
}

/** @deprecated use lifecycleSearchRange */
export function lifecycleCalendarRange(days: RefreshDay[]): string | null {
	return lifecycleSearchRange(days);
}

export function mergedPrSearchQuery(repo: string, range: string): string {
	return `repo:${repo} is:pr is:merged merged:${range}`;
}

export function closedIssueSearchQuery(repo: string, range: string): string {
	return `repo:${repo} is:issue is:closed closed:${range}`;
}

export function lifecycleSearchFields(needed: string[]) {
	const wantPrs = needed.includes("prs");
	const wantIssues = needed.includes("issues");
	const vars = [
		...(wantPrs ? [",$mergedQuery:String!"] : []),
		...(wantIssues ? [",$closedQuery:String!"] : []),
	].join("");
	const fields = [
		wantPrs
			? `mergedLifecycle: search(type: ISSUE, query: $mergedQuery, first: 100) { issueCount ${page} nodes { ... on PullRequest { id number title url state createdAt updatedAt closedAt mergedAt isDraft additions deletions baseRefName headRefName reviewDecision mergeable mergeStateStatus author { login } labels(first:20) { nodes { name color } } comments { totalCount } } } }`
			: "",
		wantIssues
			? `closedLifecycle: search(type: ISSUE, query: $closedQuery, first: 100) { issueCount ${page} nodes { ... on Issue { id number title url state createdAt updatedAt closedAt author { login } labels(first:20) { nodes { name color } } comments { totalCount } } } }`
			: "",
	].join("\n ");
	return { vars, fields, wantPrs, wantIssues };
}
type LifecycleRaw = { merged: Node[]; closed: Node[]; truncated: boolean };

function ingestSearch(connection: Node, target: Node[]) {
	const info = object(connection.pageInfo);
	for (const node of nodes(connection.nodes)) {
		if (text(node.id)) target.push(node);
	}
	return info.hasNextPage === true;
}

export function lifecycleFromResponse(data: Node, needed: string[]): LifecycleRaw {
	const merged: Node[] = [];
	const closed: Node[] = [];
	let truncated = false;
	if (needed.includes("prs") && ingestSearch(object(data.mergedLifecycle), merged))
		truncated = true;
	if (needed.includes("issues") && ingestSearch(object(data.closedLifecycle), closed))
		truncated = true;
	return { merged, closed, truncated };
}

export function lifecycleEvents(raw: LifecycleRaw, stream: "issues" | "prs"): FactoryEvent[] {
	const source = stream === "prs" ? raw.merged : raw.closed;
	return source.map((row) => event(row));
}

export function mergeLifecycleRaw(into: Map<string, Node>, raw: Node[], stream: "issues" | "prs") {
	for (const row of raw) {
		if (!text(row.id)) continue;
		const prior = into.get(String(row.id));
		into.set(String(row.id), {
			...(prior ?? {}),
			...row,
			state: stream === "prs" ? "MERGED" : "CLOSED",
			closedAt: text(row.closedAt),
			mergedAt: text(row.mergedAt),
		});
	}
}

export function dropStaleOpen(inventory: Map<string, Node>, fetchedOpenIds: Set<string>) {
	for (const [itemId, item] of inventory) {
		if (item.state !== "OPEN" || fetchedOpenIds.has(itemId)) continue;
		inventory.delete(itemId);
	}
}
