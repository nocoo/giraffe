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
export function factoryGraphqlStub(query: string): unknown | null {
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
	if (query.includes("contributionsCollection"))
		return {
			data: {
				user: {
					contributionsCollection: {
						restrictedContributionsCount: 0,
						contributionCalendar: { totalContributions: 0, weeks: [] },
					},
				},
			},
		};
	if (query.includes("object(expression")) return { data: { repository: {} } };
	return null;
}
