import type {
	ActivityCommit,
	ActivityContributions,
	ActivityCoverage,
} from "../../lib/activity-types";
import type { FactoryRun } from "../../lib/factory-run";
import type { FactoryEvent, FactoryRepo, FactoryStreamData } from "../../lib/factory-types";
import {
	completeActivity,
	duringActivity,
	isDeployWorkflow,
	requireActivityWindow,
	unknownActivity,
	workflowRun,
} from "./activity";
import { ApiError } from "./errors";
import { factoryNext } from "./factory-collect";
import { contributionTypes } from "./factory-contributions";
import { mapFactoryEvents, object, rows } from "./factory-map";
import { recordFactoryRate } from "./factory-rate";
import type { GithubClient } from "./github-client";
import { clipText } from "./text";

export type ActivitySupplement = {
	commits: ActivityCommit[] | null;
	tags: FactoryEvent[] | null;
	last_success_at: string | null;
	coverage: Record<string, ActivityCoverage>;
	phase: "refs" | "tags" | "commits" | "deploy" | "done";
	after: string | null;
	tagAfter: string | null;
	pending: { branch: string; sha: string; after: string }[];
	deployNext: string | null;
	pages: number;
};
const PAGE_BUDGET = 20;
const HISTORY =
	"history(first:100,since:$since,until:$until){nodes{oid committedDate message url author{user{login}}} pageInfo{hasNextPage endCursor}}";
const TAGS =
	'tags:refs(refPrefix:"refs/tags/",first:100,after:$tagAfter){nodes{name target{__typename oid ... on Tag{tagger{date}}}} pageInfo{hasNextPage endCursor}}';
export const ACTIVITY_REFS_QUERY = `query ActivityRefs($owner:String!,$name:String!,$after:String,$tagAfter:String,$since:GitTimestamp!,$until:GitTimestamp!){repository(owner:$owner,name:$name){refs(refPrefix:"refs/heads/",first:20,after:$after){nodes{name target{oid ... on Commit{${HISTORY}}}} pageInfo{hasNextPage endCursor}} ${TAGS}} rateLimit{remaining resetAt}}`;
const TAG_QUERY = `query ActivityTags($owner:String!,$name:String!,$tagAfter:String){repository(owner:$owner,name:$name){${TAGS}} rateLimit{remaining resetAt}}`;
const COMMIT_QUERY =
	"query ActivityBranchHistory($owner:String!,$name:String!,$sha:String!,$after:String!,$since:GitTimestamp!,$until:GitTimestamp!){repository(owner:$owner,name:$name){object(expression:$sha){... on Commit{history(first:100,after:$after,since:$since,until:$until){nodes{oid committedDate message url author{user{login}}} pageInfo{hasNextPage endCursor}}}}} rateLimit{remaining resetAt}}";
function rate(run: FactoryRun, data: Record<string, unknown>) {
	const value = object(data.rateLimit);
	if (run.checkpoint && typeof value.remaining === "number")
		recordFactoryRate(run.checkpoint, {
			remaining: value.remaining,
			resetAt: typeof value.resetAt === "string" ? value.resetAt : null,
			resource: "graphql",
			observedAt: new Date().toISOString(),
		});
}
function cursor(connection: Record<string, unknown>, previous: string | null) {
	const info = object(connection.pageInfo);
	if (info.hasNextPage === false) return null;
	if (
		info.hasNextPage !== true ||
		typeof info.endCursor !== "string" ||
		!info.endCursor ||
		info.endCursor === previous
	)
		throw new ApiError(502, "github_error", "Activity pagination incomplete");
	return info.endCursor;
}
function addCommits(
	state: ActivitySupplement,
	connection: Record<string, unknown>,
	branch: string,
	sha: string,
	after: string | null,
	run: FactoryRun,
) {
	if (!Array.isArray(connection.nodes))
		throw new ApiError(502, "github_error", "Activity branch history incomplete");
	const seen = new Set(state.commits?.map((commit) => commit.sha));
	for (const node of rows(connection.nodes)) {
		if (
			typeof node.oid !== "string" ||
			!duringActivity(String(node.committedDate), requireActivityWindow(run))
		)
			continue;
		if (seen.has(node.oid)) continue;
		seen.add(node.oid);
		state.commits ??= [];
		state.commits.push({
			sha: node.oid,
			author:
				typeof object(object(node.author).user).login === "string"
					? String(object(object(node.author).user).login)
					: null,
			message: clipText(String(node.message ?? "").split("\n")[0] ?? "", 240),
			at: String(node.committedDate),
			url: String(node.url ?? ""),
			branch,
			is_default_branch: false,
		});
	}
	const next = cursor(connection, after);
	if (next) state.pending.push({ branch, sha, after: next });
}
function addTags(
	state: ActivitySupplement,
	connection: Record<string, unknown>,
	repo: FactoryRepo,
	run: FactoryRun,
) {
	if (!Array.isArray(connection.nodes)) {
		state.coverage.tags = unknownActivity("Tag timestamps unavailable");
		return;
	}
	state.coverage.tags ??= completeActivity();
	for (const node of rows(connection.nodes)) {
		const target = object(node.target);
		const at = object(target.tagger).date;
		if (target.__typename !== "Tag" || typeof at !== "string") {
			state.coverage.tags = {
				status: "partial",
				truncated: false,
				reason: "Lightweight tags have no publication timestamp; annotated tags use tagger.date",
			};
			continue;
		}
		if (!duringActivity(at, requireActivityWindow(run))) continue;
		const id = `tag:${String(target.oid)}`;
		if (state.tags?.some((event) => event.id === id)) continue;
		state.tags ??= [];
		state.tags.push({
			id,
			title: String(node.name),
			tag_name: String(node.name),
			url: `${repo.url}/releases/tag/${encodeURIComponent(String(node.name))}`,
			at,
			createdAt: at,
			closedAt: null,
			mergedAt: null,
			author: null,
			state: "tag",
		});
	}
	state.tagAfter = cursor(connection, state.tagAfter);
}
export async function collectActivitySupplement(
	run: FactoryRun,
	repo: FactoryRepo,
	gh: GithubClient,
	token: string,
	previous: ActivitySupplement | null,
	actions?: FactoryStreamData | null,
): Promise<{ state: ActivitySupplement; done: boolean }> {
	const observedSuccess =
		actions?.coverage.status === "complete"
			? actions.items
					.map((event) => workflowRun(event, repo.branch))
					.filter(
						(event) =>
							event?.conclusion === "success" &&
							isDeployWorkflow(`${event.workflow_name} ${event.path ?? ""}`),
					)
					.map((event) => event?.updated_at ?? event?.created_at ?? "")
					.filter((at) => Number.isFinite(Date.parse(at)))
					.sort()
					.at(-1)
			: null;
	const state: ActivitySupplement = previous ?? {
		commits: [],
		tags: [],
		last_success_at: observedSuccess ?? null,
		coverage: {
			other_commits: completeActivity(),
			tags: completeActivity(),
			deploy: observedSuccess
				? completeActivity()
				: { status: "partial", truncated: false, reason: "Deployment history pending" },
		},
		phase: "refs",
		after: null,
		tagAfter: null,
		pending: [],
		deployNext: null,
		pages: 0,
	};
	if (!repo.branch) {
		state.commits = null;
		state.coverage.other_commits = unknownActivity("Current-run default branch unavailable");
		state.pending = [];
		state.after = null;
		if (state.phase === "refs" || state.phase === "commits")
			state.phase =
				state.pages === 0 || state.tagAfter ? "tags" : state.last_success_at ? "done" : "deploy";
	}
	if (state.phase === "done") return { state, done: true };
	const [owner, name] = repo.name.split("/");
	const variables = {
		owner,
		name,
		after: state.after,
		tagAfter: state.tagAfter,
		since: requireActivityWindow(run).since,
		until: requireActivityWindow(run).until,
	};
	try {
		if (state.phase === "deploy") {
			const path =
				state.deployNext ?? `/repos/${repo.name}/actions/runs?status=success&per_page=100&page=1`;
			const response = await gh.githubApi(token, path);
			const data = object(await response.json());
			if (!Array.isArray(data.workflow_runs))
				throw new ApiError(502, "github_error", "Deployment history incomplete");
			const found = mapFactoryEvents("actions", rows(data.workflow_runs))
				.map((event) => workflowRun(event, repo.branch))
				.filter(
					(event) =>
						event?.conclusion === "success" &&
						isDeployWorkflow(`${event.workflow_name} ${event.path ?? ""}`),
				)
				.map((event) => event?.updated_at ?? event?.created_at ?? "")
				.filter((at) => Number.isFinite(Date.parse(at)))
				.sort()
				.at(-1);
			state.deployNext = factoryNext(response.headers.get("link"), path);
			if (found) state.last_success_at = [state.last_success_at ?? "", found].sort().at(-1) ?? null;
			if (found || !state.deployNext) {
				state.coverage.deploy = completeActivity();
				state.phase = "done";
			}
		} else {
			const pending = state.phase === "commits" ? state.pending.shift() : null;
			const result = await gh.githubGraphql(
				token,
				state.phase === "refs"
					? ACTIVITY_REFS_QUERY
					: state.phase === "tags"
						? TAG_QUERY
						: COMMIT_QUERY,
				{ ...variables, ...(pending ? { sha: pending.sha, after: pending.after } : {}) },
			);
			rate(run, result);
			const repository = object(result.repository);
			if (gh.graphqlErrors.length || !Object.keys(repository).length)
				throw new ApiError(403, "github_forbidden", "Activity supplement unavailable");
			if (state.phase === "refs") {
				const connection = object(repository.refs);
				if (!Array.isArray(connection.nodes))
					throw new ApiError(403, "github_forbidden", "Branch evidence unavailable");
				for (const ref of rows(connection.nodes))
					if (typeof ref.name === "string" && ref.name !== repo.branch) {
						const target = object(ref.target);
						addCommits(state, object(target.history), ref.name, String(target.oid), null, run);
					}
				state.after = cursor(connection, state.after);
				if (state.pages === 0) addTags(state, object(repository.tags), repo, run);
				if (!state.after)
					state.phase = state.tagAfter
						? "tags"
						: state.pending.length
							? "commits"
							: state.last_success_at
								? "done"
								: "deploy";
			} else if (state.phase === "tags") {
				addTags(state, object(repository.tags), repo, run);
				if (!state.tagAfter)
					state.phase = state.pending.length
						? "commits"
						: state.last_success_at
							? "done"
							: "deploy";
			} else if (pending) {
				addCommits(
					state,
					object(object(repository.object).history),
					pending.branch,
					pending.sha,
					pending.after,
					run,
				);
				if (!state.pending.length) state.phase = state.last_success_at ? "done" : "deploy";
			}
		}
		state.pages++;
	} catch (error) {
		if (
			!(error instanceof ApiError) ||
			!["github_forbidden", "not_found", "github_response_too_large"].includes(error.code)
		)
			throw error;
		const key =
			state.phase === "deploy" ? "deploy" : state.phase === "tags" ? "tags" : "other_commits";
		state.coverage[key] = unknownActivity(
			"Supplement source unavailable",
			error.code === "github_response_too_large",
		);
		if (key === "other_commits") {
			state.commits = null;
			state.coverage.tags = unknownActivity("Tag timestamps unavailable");
			state.tags = null;
		}
		state.phase =
			key === "tags"
				? state.pending.length
					? "commits"
					: state.last_success_at
						? "done"
						: "deploy"
				: "done";
	}
	if (
		(state.pages >= PAGE_BUDGET && state.phase !== "done") ||
		(state.commits?.length ?? 0) > 5000 ||
		new TextEncoder().encode(JSON.stringify(state)).length > 1_200_000
	) {
		for (const key of ["other_commits", "tags", "deploy"])
			if (state.coverage[key]?.status !== "unavailable")
				state.coverage[key] = {
					status: "partial",
					truncated: true,
					reason: "Activity supplement page/item/byte budget reached",
				};
		state.commits = state.commits?.slice(0, 5000) ?? null;
		state.pending = [];
		state.after = null;
		state.tagAfter = null;
		state.deployNext = null;
		for (
			let attempt = 0;
			new TextEncoder().encode(JSON.stringify(state)).length > 1_200_000 && attempt < 32;
			attempt++
		) {
			if ((state.commits?.length ?? 0) > (state.tags?.length ?? 0))
				state.commits = state.commits?.slice(0, Math.floor(state.commits.length * 0.8)) ?? null;
			else state.tags = state.tags?.slice(0, Math.floor(state.tags.length * 0.8)) ?? null;
		}
		if (new TextEncoder().encode(JSON.stringify(state)).length > 1_200_000)
			throw new ApiError(422, "factory_capacity", "Activity supplement metadata exceeds capacity");
		state.phase = "done";
	}
	return { state, done: state.phase === "done" };
}
export async function collectActivityContributions(
	run: FactoryRun,
	gh: GithubClient,
	token: string,
): Promise<ActivityContributions> {
	const until = Date.parse(requireActivityWindow(run).until);
	const today = Math.floor((until + 8 * 3600_000) / 86400_000) * 86400_000 - 8 * 3600_000;
	const windowDay =
		Math.floor((Date.parse(requireActivityWindow(run).since) + 8 * 3600_000) / 86400_000) *
			86400_000 -
		8 * 3600_000;
	const start = Math.max(today - 89 * 86400_000, Math.min(windowDay, today - 86400_000));
	const days: ActivityContributions["days"] = [];
	const variables: Record<string, unknown> = { owner: run.owner };
	for (let at = start; at <= today; at += 86400_000) {
		const index = days.length;
		const since = new Date(at).toISOString();
		const end = new Date(Math.min(at + 86400_000 - 1, until)).toISOString();
		const date = new Date(at + 8 * 3600_000).toISOString().slice(0, 10);
		variables[`from${index}`] = `${date}T00:00:00Z`;
		variables[`to${index}`] = `${date}T23:59:59Z`;
		days.push({
			date,
			since,
			until: end,
			partial: at === today,
			count: null,
			types: contributionTypes(),
			coverage: unknownActivity("Beijing contribution types unavailable"),
		});
	}
	const declarations = days
		.map((_, index) => `$from${index}:DateTime!,$to${index}:DateTime!`)
		.join(",");
	const fields = days
		.map(
			(_, index) =>
				`day${index}:contributionsCollection(from:$from${index},to:$to${index}){totalCommitContributions totalIssueContributions(excludeFirst:false,excludePopular:false) totalPullRequestContributions(excludeFirst:false,excludePopular:false) totalPullRequestReviewContributions totalRepositoryContributions(excludeFirst:false) restrictedContributionsCount contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}`,
		)
		.join(" ");
	try {
		const data = await gh.githubGraphql(
			token,
			`query ActivityBeijingContributions($owner:String!,${declarations}){user(login:$owner){${fields}} rateLimit{remaining resetAt}}`,
			variables,
		);
		rate(run, data);
		for (const [index, day] of days.entries()) {
			day.types = contributionTypes(object(object(data.user)[`day${index}`]));
			const calendar = object(object(object(data.user)[`day${index}`]).contributionCalendar);
			const count = calendar.totalContributions;
			const total =
				typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null;
			const nativeDays = rows(calendar.weeks).flatMap((week) => rows(week.contributionDays));
			const validDays = nativeDays.every(
				(value) =>
					typeof value.date === "string" &&
					/^\d{4}-\d{2}-\d{2}$/.test(value.date) &&
					typeof value.contributionCount === "number" &&
					Number.isSafeInteger(value.contributionCount) &&
					value.contributionCount >= 0,
			);
			const matchingDay =
				validDays &&
				nativeDays.length === 1 &&
				nativeDays[0]?.date === day.date &&
				nativeDays[0]?.contributionCount === total;
			day.count = matchingDay ? total : null;
			day.nativeCalendar = {
				timezone: "github",
				total,
				days: validDays
					? nativeDays.map((value) => ({
							date: String(value.date),
							count: Number(value.contributionCount),
						}))
					: [],
			};
			const values = Object.values(day.types);
			day.coverage =
				day.count !== null &&
				values.every((value) => value !== null) &&
				values.reduce<number>((sum, value) => sum + Number(value), 0) === day.count &&
				matchingDay
					? completeActivity()
					: {
							status:
								total === null && values.every((value) => value === null)
									? "unavailable"
									: "partial",
							truncated: false,
							reason:
								"Expected one matching GitHub calendar date and consistent type composition; mismatched cells are not summed or reconstructed",
						};
		}
	} catch (error) {
		if (
			!(error instanceof ApiError) ||
			!["github_forbidden", "not_found", "github_response_too_large"].includes(error.code)
		)
			throw error;
	}
	if (start > windowDay)
		for (const day of days)
			day.coverage = {
				...day.coverage,
				truncated: true,
				reason: "Beijing contribution lookback exceeds 90-day capacity",
			};
	return { timezone: "Asia/Shanghai", days };
}
