import type { FactoryEvent } from "../../../lib/factory-types";
import type { SecurityFeatures } from "../../../lib/security";
import { ApiError } from "../errors";
import { githubUnavailability } from "../github-unavailable";
import type { CollectionContext } from "../refresh-collection-contract";
import { count, event, type Node, nodes, object, text, windowOf } from "./model";
import { itemQuery } from "./queries";
import type { transport } from "./transport";

export type Dimension = {
	items: FactoryEvent[];
	raw: Node[];
	status: "complete" | "partial" | "unavailable";
	reason: string | null;
	source: string;
	inventoryComplete?: boolean;
	features?: SecurityFeatures;
};
type Transport = ReturnType<typeof transport>;
export const terminal = (error: unknown) =>
	error instanceof ApiError && ["github_unauthorized", "github_rate_limited"].includes(error.code);
export const failure = (error: unknown): Dimension => ({
	items: [],
	raw: [],
	status: "unavailable",
	reason:
		githubUnavailability(error)?.reason_code ??
		(error instanceof ApiError &&
		["permission_denied", "not_found", "github_rate_limited", "github_unauthorized"].includes(
			error.code,
		)
			? error.code
			: "github_error"),
	source: "github",
});

export async function collectItems(
	context: CollectionContext,
	transport: Transport,
	id: string,
	stream: "issues" | "prs",
	connection: Node,
	cached: Map<string, Node>,
	completeThrough: string | null,
): Promise<Dimension> {
	const result: Dimension = {
		items: [],
		raw: [],
		status: transport.client.graphqlErrors.length ? "partial" : "complete",
		reason: transport.client.graphqlErrors.length ? "graphql_partial" : null,
		source: "github_graphql",
		inventoryComplete: false,
	};
	const cursors = new Set<string>();
	for (;;) {
		if (!Array.isArray(connection.nodes)) return { ...failure(null), inventoryComplete: false };
		const page = nodes(connection.nodes);
		let boundary = false;
		for (const raw of page) {
			if (!text(raw.id)) {
				result.status = "partial";
				continue;
			}
			result.raw.push(raw);
			result.items.push(event(raw));
			const prior = cached.get(String(raw.id));
			boundary ||=
				completeThrough !== null &&
				prior !== undefined &&
				text(raw.updatedAt) !== null &&
				Date.parse(String(raw.updatedAt)) <= Date.parse(completeThrough) &&
				["updatedAt", "state", "createdAt", "closedAt", "mergedAt"].every(
					(field) => raw[field] === prior[field],
				);
		}
		const info = object(connection.pageInfo);
		if (info.hasNextPage === false)
			return { ...result, inventoryComplete: result.status === "complete" };
		const lastUpdated = text(page.at(-1)?.updatedAt);
		if (
			!context.run.params.force &&
			boundary &&
			lastUpdated !== null &&
			Date.parse(lastUpdated) <= Date.parse(String(completeThrough))
		)
			return { ...result, inventoryComplete: result.status === "complete" };
		if (lastUpdated !== null && Date.parse(lastUpdated) < Date.parse(windowOf(context).since))
			return result;
		const after = text(info.endCursor);
		if (!after || cursors.has(after))
			return { ...result, status: "partial", reason: "incomplete_pagination" };
		cursors.add(after);
		try {
			const data = await transport.request((client) =>
				client.githubGraphql(context.token, itemQuery(stream), { id, after }),
			);
			connection = object(object(data.node)[stream === "prs" ? "pullRequests" : "issues"]);
			if (transport.client.graphqlErrors.length) {
				result.status = "partial";
				result.reason = "graphql_partial";
			}
		} catch (error) {
			if (terminal(error)) throw error;
			return { ...result, status: "partial", reason: "github_error" };
		}
	}
}

export async function collectRest(
	context: CollectionContext,
	transport: Transport,
	repo: string,
	stream: "actions" | "releases" | "alerts",
): Promise<Dimension> {
	const path = `/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;
	const get = (suffix: string) =>
		transport.request(async (client) => {
			const response = await client.githubApi(context.token, `${path}${suffix}`);
			return {
				body: (await response.json()) as unknown,
				next: response.headers.get("link")?.includes('rel="next"') === true,
			};
		});
	if (stream === "alerts") {
		const results: Dimension[] = [];
		for (const kind of ["dependabot", "code-scanning"]) {
			try {
				const { body, next } = await get(`/${kind}/alerts?state=open&per_page=100`);
				if (!Array.isArray(body)) {
					results.push(failure(null));
					continue;
				}
				const raw: Node[] = nodes(body).map((row) => ({
					...row,
					source: kind === "code-scanning" ? "code_scanning" : kind,
				}));
				results.push({
					raw,
					items: raw.map((row) => {
						const advisory = object(row.security_advisory);
						const rule = object(row.rule);
						return {
							...event({
								id: `${kind}:${row.number}`,
								title: advisory.summary ?? rule.description,
								url: row.html_url,
								state: row.state,
								createdAt: row.created_at,
								updatedAt: row.updated_at,
							}),
							severity: text(advisory.severity ?? rule.security_severity_level),
						};
					}),
					status: next ? "partial" : "complete",
					reason: next ? "latest_page_only" : null,
					source: "github_rest_latest",
				});
			} catch (error) {
				if (terminal(error)) throw error;
				results.push(failure(error));
			}
		}
		return {
			features: Object.fromEntries(
				results.map((result, index) => [
					index === 0 ? "dependabot" : "code_scanning",
					{
						status: result.status === "complete" ? "available" : result.status,
						reason_code:
							result.status === "unavailable"
								? [
										"alerts_disabled",
										"code_scanning_disabled",
										"permission_denied",
										"not_found",
									].includes(result.reason ?? "")
									? result.reason
									: "unknown"
								: null,
						reason: result.reason,
					},
				]),
			) as SecurityFeatures,
			items: results.flatMap((result) => result.items),
			raw: results.flatMap((result) => result.raw),
			status: results.every((result) => result.status === "complete")
				? "complete"
				: results.every((result) => result.status === "unavailable")
					? "unavailable"
					: "partial",
			reason: results.find((result) => result.reason)?.reason ?? null,
			source: "github_rest_latest",
		};
	}
	const { body, next } = await get(
		stream === "actions" ? "/actions/runs?per_page=100" : "/releases?per_page=100",
	);
	const value = stream === "actions" ? object(body).workflow_runs : body;
	if (!Array.isArray(value)) return failure(null);
	const raw = nodes(value);
	const oldest = raw.at(-1);
	const at = stream === "actions" ? oldest?.created_at : oldest?.published_at;
	const truncated =
		(next || (stream === "actions" && (count(object(body).total_count) ?? 0) > raw.length)) &&
		(!text(at) || Date.parse(String(at)) >= Date.parse(windowOf(context).since));
	return {
		raw,
		items: raw.map((row) => ({
			...event({
				id: String(row.id),
				title: row.name ?? row.tag_name,
				url: row.html_url,
				state: row.status ?? (row.draft ? "draft" : "published"),
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			}),
			at: text(stream === "releases" ? row.published_at : row.created_at),
			conclusion: text(row.conclusion),
			tag_name: text(row.tag_name),
		})),
		status: truncated ? "partial" : "complete",
		reason: truncated ? "latest_page_only" : null,
		source: "github_rest_latest",
	};
}
