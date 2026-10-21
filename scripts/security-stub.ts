import { githubUnavailableFixtures } from "../tests/fixtures/github-unavailable";
import { factoryGraphqlStub, factoryRepoStub } from "./factory-stub";

export function securityFixture(auth: string) {
	const letters = ["E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O"];
	const index = letters.findIndex((letter) => auth.includes(letter.repeat(8)));
	const letter = letters[index];
	const code =
		["alerts_disabled", "permission_denied", "not_found", "unknown"][index] ?? "alerts_disabled";
	const fixture = index < 0 ? null : githubUnavailableFixtures.find((item) => item.code === code);
	if (!fixture) return null;
	const regression = ["malformed-issues", "malformed-prs", "interrupted-actions"][index - 4];
	const owner =
		`availability-${regression ?? (index >= 7 ? letter : fixture.code.replaceAll("_", "-"))}`.toLowerCase();
	const openAlerts = Array.from({ length: letter === "M" ? 2 : 0 }, (_, id) => ({
		number: id + 1,
		id: `A_${id}`,
		state: "open",
		created_at: "2020-01-01T00:00:00Z",
		security_advisory: { severity: "high", summary: "Open dependency alert" },
	}));
	const repo = {
		...factoryRepoStub,
		id: `R_${owner}`,
		nameWithOwner: `${owner}/hello-world`,
		owner: { login: owner },
		url: `https://github.com/${owner}/hello-world`,
	};
	return {
		owner,
		graphql(query: string, variables: Record<string, unknown>) {
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
			if (query.includes("vulnerabilityAlerts") && (letter === "M" || letter === "O")) {
				const nodes = openAlerts.map((alert) => ({
					id: alert.id,
					state: "OPEN",
					securityAdvisory: { summary: "Open dependency alert" },
				}));
				if (!/states:\s*OPEN/.test(query))
					nodes.push(
						...Array.from({ length: 6 }, (_, id) => ({
							id: `FIXED_${id}`,
							state: "FIXED",
							securityAdvisory: { summary: "Fixed dependency alert" },
						})),
					);
				return {
					data: {
						repository: { vulnerabilityAlerts: { nodes, pageInfo: { hasNextPage: false } } },
					},
				};
			}
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
			return factoryGraphqlStub(query, variables);
		},
		rest(
			path: string,
			search = "",
		): { status: number; body: unknown; headers?: Record<string, string> } {
			const params = new URLSearchParams(search);
			if (path.endsWith("/dependabot/alerts") && (letter === "M" || letter === "O"))
				return { status: 200, body: params.get("state") === "open" ? openAlerts : null };
			if (path.endsWith("/code-scanning/alerts") && (letter === "N" || letter === "O"))
				return { status: 200, body: [] };
			if (path.endsWith("/code-scanning/alerts") && (letter === "L" || letter === "M"))
				return {
					status: letter === "L" ? 403 : 404,
					body: { message: letter === "L" ? "Code scanning is not enabled" : "Not Found" },
				};
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
