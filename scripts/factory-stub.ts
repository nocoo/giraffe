/** Isolated HTTP fixtures shared by L2 and the real-Worker browser smoke. */
export const factoryRepoStub = {
	id: "R_factory_fixture",
	nameWithOwner: "octocat/hello-world",
	name: "hello-world",
	owner: { login: "octocat" },
	url: "https://github.com/octocat/hello-world",
	description: "Factory fixture",
	isPrivate: false,
	isArchived: false,
	isFork: false,
	diskUsage: 42,
	pushedAt: "2026-09-15T00:00:00Z",
	primaryLanguage: { name: "TypeScript" },
	languages: {
		totalSize: 100,
		totalCount: 1,
		edges: [{ size: 100, node: { name: "TypeScript" } }],
	},
	repositoryTopics: { nodes: [] },
	defaultBranchRef: { name: "main", target: { oid: "abc", history: { totalCount: 1 } } },
	openIssues: { totalCount: 0 },
	closedIssues: { totalCount: 0 },
	openPrs: { totalCount: 0 },
	closedPrs: { totalCount: 0 },
	mergedPrs: { totalCount: 0 },
	releases: { totalCount: 0 },
};
export function factoryRestStub(url: URL): unknown | null {
	if (
		url.pathname !== "/repos/octocat/hello-world/commits" ||
		url.searchParams.get("sha") !== "abc" ||
		url.searchParams.has("since") ||
		url.searchParams.has("until")
	)
		return null;
	return [
		{
			sha: "abc",
			commit: {
				message: "Previously authored, newly observed",
				committer: { date: "2020-01-01T00:00:00Z" },
			},
			author: { login: "octocat" },
			html_url: "https://github.com/octocat/hello-world/commit/abc",
		},
	];
}
export function factoryGraphqlStub(
	query: string,
	variables: Record<string, unknown>,
): unknown | null {
	const emptyConnection = { nodes: [], pageInfo: { hasNextPage: false } };
	if (query.includes("query ActivityRefs"))
		return { data: { repository: { refs: emptyConnection, tags: emptyConnection } } };
	if (query.includes("query ActivityTags"))
		return { data: { repository: { tags: emptyConnection } } };
	if (query.includes("query ActivityBranchHistory"))
		return { data: { repository: { object: { history: emptyConnection } } } };
	if (query.includes("repositories(first:10,"))
		return {
			data: {
				viewer: {
					login: "octocat",
					repositories: {
						totalCount: 1,
						nodes: [factoryRepoStub],
						pageInfo: { hasNextPage: false },
					},
				},
			},
		};
	if (query.includes("nameWithOwner") && query.includes("openPrs:"))
		return { data: { repository: factoryRepoStub } };
	if (query.includes("contributionsCollection") && query.includes("$since")) {
		const start = Date.parse(String(variables.since));
		const end = Date.parse(String(variables.until));
		const contributionDays = Array.from(
			{ length: Math.floor((end - start) / 86400_000) + 1 },
			(_, index) => ({
				date: new Date(start + index * 86400_000).toISOString().slice(0, 10),
				contributionCount: 0,
			}),
		);
		return {
			data: {
				user: {
					contributionsCollection: {
						restrictedContributionsCount: 0,
						contributionCalendar: { totalContributions: 0, weeks: [{ contributionDays }] },
					},
				},
			},
		};
	}
	if (query.includes("contributionsCollection"))
		return {
			data: {
				user: Object.fromEntries(
					Object.keys(variables)
						.filter((key) => key.startsWith("from"))
						.map((key) => [
							key.replace("from", "day"),
							{
								contributionCalendar: { totalContributions: 0, weeks: [] },
								totalCommitContributions: 0,
								totalIssueContributions: 0,
								totalPullRequestContributions: 0,
								totalPullRequestReviewContributions: 0,
								restrictedContributionsCount: 0,
								totalRepositoryContributions: 0,
							},
						]),
				),
			},
		};
	if (query.includes("object(expression")) return { data: { repository: {} } };
	return null;
}
