import { ApiError } from "../errors";
import { createGithubClient, type GithubClient } from "../github-client";
import type { CollectionContext, RequestBreakdown } from "../refresh-collection-contract";

export function transport(context: CollectionContext) {
	const client = createGithubClient(context.env);
	const breakdown = (): RequestBreakdown => ({ ...client.requests });
	return {
		client,
		breakdown,
		request: async <Result>(
			operation: (client: GithubClient) => Promise<Result>,
		): Promise<Result> => {
			try {
				return await operation(client);
			} catch (error) {
				if (!(error instanceof ApiError) || error.status !== 502 || error.code !== "github_error")
					throw error;
				return await operation(client);
			} finally {
				context.onRequests?.(client.count, breakdown());
			}
		},
	};
}
