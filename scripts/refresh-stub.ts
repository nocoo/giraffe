export function refreshGraphqlStub(
	query: string,
	variables: Record<string, unknown>,
	owner = "octocat",
) {
	const repo = owner === "phase2" ? "demo" : "hello-world";
	const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
	const metadata = {
		id: `R_refresh_${owner}`,
		name: repo,
		nameWithOwner: `${owner}/${repo}`,
		owner: { login: owner },
		url: `https://github.com/${owner}/${repo}`,
		description: "Unified refresh fixture",
		isPrivate: false,
		isArchived: false,
		isFork: false,
		isEmpty: false,
		stargazerCount: 1,
		forkCount: 0,
		diskUsage: 42,
		visibility: "PUBLIC",
		pushedAt: "2026-10-01T00:00:00Z",
		createdAt: "2026-01-01T00:00:00Z",
		primaryLanguage: { name: "TypeScript" },
	};
	const rateLimit = { remaining: 4999, resetAt: new Date(Date.now() + 3_600_000).toISOString() };
	const issueAt = new Date(
		Date.parse(String(variables.since0 ?? "2026-10-28T00:00:00Z")) + 3_600_000,
	).toISOString();
	const issues =
		owner === "phase2"
			? [
					{
						id: "I_refresh_phase2",
						number: 1,
						title: "Fresh lifecycle observation",
						url: "https://github.com/phase2/demo/issues/1",
						state: "OPEN",
						createdAt: issueAt,
						updatedAt: issueAt,
						closedAt: null,
						author: { login: "phase2" },
						labels: { nodes: [] },
						comments: { totalCount: 0 },
					},
				]
			: [];
	if (query.includes("query RefreshAccount")) {
		const since = Date.parse(String(variables.since));
		const until = Date.parse(String(variables.until));
		const days = Array.from(
			{ length: Math.max(1, Math.ceil((until - since) / 86_400_000)) },
			(_, index) => ({
				date: new Date(since + index * 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10),
				contributionCount: 2,
			}),
		);
		return {
			data: {
				viewer: {
					login: owner,
					avatarUrl: "",
					repositories: { nodes: [metadata], totalCount: 1, pageInfo: empty.pageInfo },
					contributionsCollection: {
						restrictedContributionsCount: 0,
						contributionCalendar: {
							totalContributions: days.length * 2,
							weeks: [{ contributionDays: days }],
						},
					},
				},
				rateLimit,
			},
		};
	}
	if (query.includes("query RefreshRepository"))
		return {
			data: {
				node: {
					...metadata,
					defaultBranchRef: {
						name: "main",
						target: {
							oid: "fixture-head",
							history: { totalCount: 5 },
							...Object.fromEntries(
								Object.keys(variables)
									.filter((key) => key.startsWith("since"))
									.map((key) => [`day${key.slice(5)}`, { totalCount: 2 }]),
							),
						},
					},
					languages: {
						totalSize: 10,
						edges: [{ size: 10, node: { name: "TypeScript" } }],
						pageInfo: { hasNextPage: false },
					},
					repositoryTopics: { nodes: [] },
					openIssues: { totalCount: issues.length },
					closedIssues: { totalCount: 0 },
					openPrs: { totalCount: 0 },
					closedPrs: { totalCount: 0 },
					mergedPrs: { totalCount: 0 },
					releases: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
					issues: { ...empty, nodes: issues },
					pullRequests: empty,
				},
				rateLimit,
			},
		};
	if (query.includes("query RefreshItems"))
		return { data: { node: { issues: empty, pullRequests: empty } } };
	return null;
}
export function refreshRestStub(url: URL): unknown | null {
	if (!url.pathname.startsWith("/repos/phase2/demo/")) return null;
	return url.pathname.endsWith("/actions/runs") ? { total_count: 0, workflow_runs: [] } : [];
}
