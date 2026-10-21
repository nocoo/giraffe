import { githubUnavailableFixtures } from "../tests/fixtures/github-unavailable";
import { factoryGraphqlStub, factoryRepoStub } from "./factory-stub";

export function securityFixture(auth: string) {
	const index = ["E", "F", "G", "H", "I", "J", "K"].findIndex((letter) =>
		auth.includes(letter.repeat(8)),
	);
	const fixture = githubUnavailableFixtures[[0, 2, 5, 6, 0, 0, 0][index] ?? -1];
	if (!fixture) return null;
	const regression = ["malformed-issues", "malformed-prs", "interrupted-actions"][index - 4];
	const owner = `availability-${regression ?? fixture.code.replaceAll("_", "-")}`;
	const repo = {
		...factoryRepoStub,
		id: `R_${owner}`,
		nameWithOwner: `${owner}/hello-world`,
		owner: { login: owner },
		url: `https://github.com/${owner}/hello-world`,
	};
	return {
		owner,
		graphql(query: string) {
			if (query.includes("viewer"))
				return {
					data: {
						viewer: {
							login: owner,
							repositories: { totalCount: 1, nodes: [repo], pageInfo: { hasNextPage: false } },
						},
					},
				};
			if (query.includes("openPrs:")) return { data: { repository: repo } };
			if (query.includes("vulnerabilityAlerts"))
				return {
					data: { repository: null },
					errors: [
						{
							type: fixture.status === 404 ? "NOT_FOUND" : "FORBIDDEN",
							message: fixture.message,
							path: ["repository"],
						},
					],
				};
			if (
				query.includes("search") &&
				((regression === "malformed-issues" && !query.includes("PullRequest")) ||
					(regression === "malformed-prs" && query.includes("PullRequest")))
			)
				return { data: { search: {} } };
			if (query.includes("search"))
				return { data: { search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } } } };
			return factoryGraphqlStub(query);
		},
		rest(
			path: string,
			search = "",
		): { status: number; body: unknown; headers?: Record<string, string> } {
			const params = new URLSearchParams(search);
			if (
				regression === "interrupted-actions" &&
				path.endsWith("/actions/runs") &&
				!params.has("created")
			) {
				if (params.has("page"))
					return { status: 403, body: { message: "Resource not accessible by integration" } };
				return {
					status: 200,
					body: { workflow_runs: [{ id: 1 }] },
					headers: { link: `<https://api.github.com${path}?page=2>; rel="next"` },
				};
			}
			if (path.endsWith("/dependabot/alerts") || path.endsWith("/code-scanning/alerts"))
				return {
					status: fixture.status,
					body: { message: fixture.message, private_diagnostics: "private upstream diagnostics" },
				};
			if (path.endsWith("/actions/runs"))
				return { status: 200, body: { total_count: 0, workflow_runs: [] } };
			if (path.endsWith("/languages")) return { status: 200, body: {} };
			if (path.includes("/traffic/"))
				return { status: 200, body: { count: 0, uniques: 0, views: [], clones: [] } };
			if (path === `/repos/${owner}/hello-world`)
				return { status: 200, body: { default_branch: "main", html_url: repo.url } };
			return { status: 200, body: [] };
		},
	};
}
