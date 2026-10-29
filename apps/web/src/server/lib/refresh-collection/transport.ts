import type { RefreshFailureDetail } from "../../../lib/refresh-types";
import { ApiError } from "../errors";
import { createGithubClient, type GithubClient } from "../github-client";
import { githubUnavailability } from "../github-unavailable";
import type { CollectionContext, RequestBreakdown } from "../refresh-collection-contract";

type GraphqlError = GithubClient["graphqlErrors"][number];
export type TransportFailure = RefreshFailureDetail;
const details = new WeakMap<object, TransportFailure>();

export function transportFailure(error: unknown): TransportFailure | null {
	return error !== null && typeof error === "object" ? (details.get(error) ?? null) : null;
}

const GRAPHQL_FIELDS = new Map([
	["issues", "issues"],
	["pullRequests", "prs"],
	["releases", "releases"],
	["defaultBranchRef", "commits"],
	["history", "commits"],
	["repositories", "catalog"],
	["contributionsCollection", "contributions"],
]);
export function dimensionOfGraphqlPath(path: string[]): string | null {
	for (const segment of path) {
		const dimension = GRAPHQL_FIELDS.get(segment);
		if (dimension) return dimension;
		if (/^day\d+$/.test(segment)) return "commits";
	}
	return null;
}
function graphqlFailure(error: GraphqlError): TransportFailure {
	const classified = error.reasonCode && error.reasonCode !== "unknown" ? error.reasonCode : null;
	return {
		dimension: dimensionOfGraphqlPath(error.path),
		code: classified ?? "graphql_partial",
		httpStatus: null,
		graphqlType: error.type ?? null,
		graphqlPath: error.path.length ? error.path : null,
	};
}
function thrownFailure(
	error: unknown,
	graphqlError: GraphqlError | undefined,
	dimension: string | null,
): TransportFailure {
	const failure = {
		dimension: (graphqlError ? dimensionOfGraphqlPath(graphqlError.path) : null) ?? dimension,
		code:
			error instanceof ApiError
				? (githubUnavailability(error)?.reason_code ?? error.code)
				: "github_error",
		httpStatus: error instanceof ApiError ? error.upstreamStatus : null,
		graphqlType: graphqlError?.type ?? null,
		graphqlPath: graphqlError?.path.length ? graphqlError.path : null,
	};
	if (error !== null && typeof error === "object") details.set(error, failure);
	return failure;
}

export function transport(context: CollectionContext) {
	const client = createGithubClient(context.env);
	const failures: TransportFailure[] = [];
	const breakdown = (): RequestBreakdown => ({ ...client.requests });
	return {
		client,
		breakdown,
		failures,
		request: async <Result>(
			operation: (client: GithubClient) => Promise<Result>,
			dimension?: string,
		): Promise<Result> => {
			const graphqlCalls = client.requests.graphql;
			let remembered: GraphqlError | undefined;
			try {
				let result: Result;
				try {
					result = await operation(client);
				} catch (error) {
					if (!(error instanceof ApiError) || error.status !== 502 || error.code !== "github_error")
						throw error;
					remembered = client.requests.graphql > graphqlCalls ? client.graphqlErrors[0] : undefined;
					result = await operation(client);
				}
				if (client.requests.graphql > graphqlCalls)
					for (const error of client.graphqlErrors) failures.push(graphqlFailure(error));
				return result;
			} catch (error) {
				failures.push(
					thrownFailure(
						error,
						client.requests.graphql > graphqlCalls
							? (client.graphqlErrors[0] ?? remembered)
							: undefined,
						dimension ?? null,
					),
				);
				throw error;
			} finally {
				context.onRequests?.(client.count, breakdown());
			}
		},
	};
}
