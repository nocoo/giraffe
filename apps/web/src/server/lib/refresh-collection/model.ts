import type {
	FactoryCoverage,
	FactoryDay,
	FactoryEvent,
	FactoryMetrics,
	FactoryRepo,
	FactoryStreamName,
} from "../../../lib/factory-types";
import { ApiError } from "../errors";
import type { CollectionContext } from "../refresh-collection-contract";

export type Node = Record<string, unknown>;
export type Catalog = {
	repo_id: string;
	repo: string;
	payload: string;
	discovered_day: string;
	timezone: string;
	fetched_at: string;
};
export type DayObservation = {
	day: string;
	dimension: string;
	status: "complete" | "partial" | "unavailable";
	payload: string;
	fetched_at: string;
};
export const object = (value: unknown): Node =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Node) : {};
export const nodes = (value: unknown): Node[] => (Array.isArray(value) ? value.map(object) : []);
export const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
export const count = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
export const blankDay = (): FactoryDay => ({
	commits: 0,
	issueOpened: 0,
	issueClosed: 0,
	prOpened: 0,
	prMerged: 0,
	prClosed: 0,
	ciSuccess: 0,
	ciFailure: 0,
	releases: 0,
});
export const blankMetrics = (): FactoryMetrics => ({
	...blankDay(),
	ciOther: 0,
	ciPending: 0,
	agedPrs: 0,
	agedIssues: 0,
	botOpen: 0,
	botMerged: 0,
	alerts: 0,
	cycleHours: [],
	days: {},
	authors: {},
});
export function windowOf(context: CollectionContext) {
	const first = context.days[0];
	const last = context.days.at(-1);
	if (!first || !last) throw new ApiError(400, "validation_failed", "Refresh days required");
	return {
		since: first.since,
		until: new Date(Date.parse(last.until) - 1).toISOString(),
		timezone: context.run.params.timezone,
	};
}
export function unavailable(source: string, reason = "not_collected"): FactoryCoverage {
	return { status: "unavailable", pages: 0, fetchedAt: null, source, reason, observed: 0 };
}
export function factoryRepo(raw: Node, context: CollectionContext): FactoryRepo {
	const branch = object(raw.defaultBranchRef);
	const target = object(branch.target);
	const languages = object(raw.languages);
	const edges = nodes(languages.edges);
	return {
		id: String(raw.id),
		name: String(raw.nameWithOwner),
		url: String(raw.url ?? ""),
		description: text(raw.description),
		private: raw.isPrivate === true,
		diskKiB: count(raw.diskUsage) ?? 0,
		pushedAt: text(raw.pushedAt),
		language: text(object(raw.primaryLanguage).name) ?? "",
		languages: edges.map((edge) => ({
			name: String(object(edge.node).name),
			bytes: count(edge.size) ?? 0,
		})),
		languageBytes: count(languages.totalSize) ?? 0,
		languagesComplete: object(languages.pageInfo).hasNextPage === false,
		topics: nodes(object(raw.repositoryTopics).nodes).map((topic) =>
			String(object(topic.topic).name),
		),
		branch: text(branch.name),
		head: text(target.oid),
		totalCommits: count(object(target.history).totalCount) ?? 0,
		openIssues: count(object(raw.openIssues).totalCount) ?? 0,
		closedIssues: count(object(raw.closedIssues).totalCount) ?? 0,
		openPrs: count(object(raw.openPrs).totalCount) ?? 0,
		closedPrs: count(object(raw.closedPrs).totalCount) ?? 0,
		mergedPrs: count(object(raw.mergedPrs).totalCount) ?? 0,
		totalReleases: count(object(raw.releases).totalCount) ?? 0,
		is_fork: raw.isFork === true,
		is_archived: raw.isArchived === true,
		metadataAt: context.now,
		coverage: Object.fromEntries(
			["commits", "issues", "prs", "actions", "releases", "alerts", "dependencies"].map(
				(stream) => [
					stream,
					unavailable(
						stream,
						stream === "dependencies" ? "dependency_analysis_unavailable" : "not_collected",
					),
				],
			),
		) as Record<FactoryStreamName, FactoryCoverage>,
		metrics: blankMetrics(),
		dependencies: [],
	};
}
export function event(raw: Node): FactoryEvent {
	return {
		id: String(raw.id),
		title: String(raw.title ?? ""),
		url: String(raw.url ?? ""),
		at: text(raw.createdAt),
		createdAt: text(raw.createdAt),
		updatedAt: text(raw.updatedAt),
		closedAt: text(raw.closedAt),
		mergedAt: text(raw.mergedAt),
		author: text(object(raw.author).login),
		state: raw.mergedAt ? "merged" : String(raw.state ?? "").toLowerCase(),
		draft: raw.isDraft === true,
	};
}
