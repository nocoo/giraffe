import type { FactoryEvent, FactorySnapshot } from "../../lib/factory-types";
import { prState } from "../../lib/pull-request";
import { ApiError } from "./errors";
import { object, rows } from "./factory-map";
import type { GithubClient } from "./github-client";

export const PR_STATE_FIELDS =
	"mergeable mergeStateStatus commits(last:1){nodes{commit{statusCheckRollup{state}}}}";

export async function collectPrState(
	snapshot: FactorySnapshot,
	gh: GithubClient,
	token: string,
	items: FactoryEvent[],
	now: string,
): Promise<FactoryEvent[]> {
	if (!items.length) return items;
	const ids = [...new Set(items.map((item) => item.id))];
	if (ids.length > 100) throw new ApiError(502, "github_error", "PR page exceeds batch limit");
	let result: Record<string, unknown>;
	try {
		result = await gh.githubGraphql(
			token,
			`query($ids:[ID!]!){nodes(ids:$ids){... on PullRequest{id ${PR_STATE_FIELDS}}} rateLimit{remaining resetAt}}`,
			{ ids },
		);
	} catch (error) {
		if (error instanceof ApiError && ["github_forbidden", "not_found"].includes(error.code))
			return items;
		throw error;
	}
	const rate = object(result.rateLimit);
	if (typeof rate.remaining === "number")
		snapshot.rate = {
			remaining: rate.remaining,
			resetAt: typeof rate.resetAt === "string" ? rate.resetAt : null,
			resource: "graphql",
			observedAt: now,
		};
	if (!Array.isArray(result.nodes)) {
		if (gh.graphqlErrors.length) return items;
		throw new ApiError(502, "github_error", "PR state response incomplete");
	}
	const states = new Map(rows(result.nodes).map((node) => [node.id, prState(node)]));
	return items.map((item) => ({ ...item, ...(states.get(item.id) ?? prState(null)) }));
}
