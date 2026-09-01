import { describe, expect, it } from "vitest";
import {
	clampToBudget,
	collectKind,
	collectRepos,
	emptyCollected,
	MAX_STAGED_BYTES,
	nextPath,
	ownerName,
} from "./collect";
import { ApiError } from "./errors";
import type { GithubClient } from "./github-client";
import { TruncatedError } from "./github-client";

function client(opts: {
	graphql?: (
		query: string,
		variables: Record<string, unknown>,
	) => Promise<Record<string, unknown>> | Record<string, unknown>;
	api?: (path: string) => Promise<Response> | Response;
}): GithubClient {
	return {
		count: 0,
		graphqlErrors: [],
		githubFetch: async () => new Response("{}"),
		githubApi: async (_token, path) => {
			if (!opts.api) {
				return new Response("[]");
			}
			return await opts.api(path);
		},
		githubGraphql: async (_token, query, variables) => {
			if (!opts.graphql) {
				return {};
			}
			return await opts.graphql(query, variables);
		},
	};
}

const issueNode = {
	__typename: "Issue",
	number: 1,
	title: "bug",
	url: "https://x",
	createdAt: "t",
	updatedAt: "t",
	author: { login: "a" },
	labels: { nodes: [{ name: "x", color: "fff" }] },
	comments: { totalCount: 2 },
	repository: { nameWithOwner: "o/n" },
};

describe("collect helpers", () => {
	it("parses owner names, next links, and clamps staged bytes", () => {
		expect(ownerName("o/n")).toEqual({ owner: "o", name: "n" });
		expect(ownerName("solo")).toEqual({ owner: "solo", name: "" });
		expect(MAX_STAGED_BYTES).toBe(16 * 1024 * 1024);
		expect(nextPath(new Response("[]"))).toBeNull();
		expect(
			nextPath(new Response("[]", { headers: { link: '<https://x>; rel="prev"' } })),
		).toBeNull();
		expect(
			nextPath(new Response("[]", { headers: { link: '<not-a-url>; rel="next"' } })),
		).toBeNull();
		expect(
			nextPath(
				new Response("[]", {
					headers: { link: '<https://api.github.com/notifications?page=2>; rel="next"' },
				}),
			),
		).toBe("/notifications?page=2");
		const small = clampToBudget({ truncated: false, items: [1, 2] }, 10_000);
		expect(small.capped).toBe(false);
		const capped = clampToBudget({ truncated: false, items: ["aaaa", "bbbb", "cccc"] }, 40);
		expect(capped.payload.truncated).toBe(true);
		expect(capped.capped).toBe(true);
		const noArray = clampToBudget({ truncated: false, fetched_at: "t", languages: { ts: 1 } }, 1);
		expect(noArray.payload.truncated).toBe(true);
		expect(noArray.payload.fetched_at).toBe("t");
		expect(noArray.bytes).toBe(0);
		const empty = clampToBudget({ truncated: false, items: ["zzzzzzzz"] }, 0);
		expect(empty.payload.items).toEqual([]);
		expect(empty.bytes).toBe(0);
		expect(emptyCollected("repo:o/n:details", "t")).toMatchObject({
			truncated: true,
			fetched_at: "t",
			default_branch: "",
			url: "",
		});
		expect(emptyCollected("repos", "t").repos).toEqual([]);
		expect(emptyCollected("issues", "t").issues).toEqual([]);
		expect(emptyCollected("prs", "t").pull_requests).toEqual([]);
		expect(emptyCollected("alerts", "t")).toMatchObject({ unavailable: true, items: [] });
		expect(emptyCollected("notifications", "t").notifications).toEqual([]);
		expect(emptyCollected("repo:o/n:actions", "t").runs).toEqual([]);
		expect(emptyCollected("repo:o/n:traffic", "t")).toMatchObject({ forbidden: false });
		expect(emptyCollected("repo:o/n:security", "t")).toMatchObject({ unavailable: true });
		expect(emptyCollected("repo:o/n:issues", "t").issues).toEqual([]);
		expect(emptyCollected("repo:o/n:prs", "t").pull_requests).toEqual([]);
		expect(emptyCollected("repo:o/n:releases", "t").releases).toEqual([]);
		expect(emptyCollected("repo:o/n:languages", "t").languages).toEqual({});
		expect(emptyCollected("repo:o/n:contributors", "t").contributors).toEqual([]);
		expect(emptyCollected("other", "t")).toEqual({ fetched_at: "t", truncated: true });
	});
});

describe("collectRepos", () => {
	it("pages viewer repositories and maps nodes", async () => {
		let page = 0;
		const gh = client({
			graphql: (_q, vars) => {
				page += 1;
				if (!vars.after) {
					return {
						viewer: {
							repositories: {
								nodes: [{ nameWithOwner: "o/a", issues: { totalCount: 3 } }],
								pageInfo: { hasNextPage: true, endCursor: "c1" },
							},
						},
					};
				}
				return {
					viewer: {
						repositories: {
							nodes: [{ nameWithOwner: "o/b" }],
							pageInfo: { hasNextPage: false },
						},
					},
				};
			},
		});
		const out = await collectRepos(gh, "tok");
		expect(out.truncated).toBe(false);
		expect((out.repos as unknown[]).length).toBe(2);
		expect(page).toBe(2);
		const withNull = client({
			graphql: () => ({
				viewer: {
					repositories: {
						nodes: [null as unknown as Record<string, unknown>, { nameWithOwner: "o/c" }],
						pageInfo: { hasNextPage: false },
					},
				},
			}),
		});
		expect(((await collectRepos(withNull, "tok")).repos as unknown[]).length).toBe(1);
		const soft = client({
			graphql: () => ({
				viewer: { repositories: { nodes: [{ nameWithOwner: "o/a" }], pageInfo: {} } },
			}),
		});
		soft.githubGraphql = async () => {
			soft.graphqlErrors = [{ type: "FORBIDDEN" }];
			return {
				viewer: { repositories: { nodes: [{ nameWithOwner: "o/a" }], pageInfo: {} } },
			};
		};
		expect((await collectRepos(soft, "tok")).truncated).toBe(true);
	});

	it("marks truncated when the fetch cap hits", async () => {
		const gh = client({
			graphql: async () => {
				throw new TruncatedError();
			},
		});
		const out = await collectRepos(gh, "tok");
		expect(out.truncated).toBe(true);
		expect(out.repos).toEqual([]);
	});

	it("rethrows hard graphql failures", async () => {
		const gh = client({
			graphql: async () => {
				throw new ApiError(401, "github_unauthorized", "no");
			},
		});
		await expect(collectRepos(gh, "tok")).rejects.toMatchObject({ code: "github_unauthorized" });
	});
});

describe("collectKind", () => {
	it("rejects unknown kinds", async () => {
		await expect(collectKind(client({}), "tok", "nope", [])).rejects.toMatchObject({
			code: "validation_failed",
		});
		await expect(collectKind(client({}), "tok", "repo:o/n:nope", [])).rejects.toMatchObject({
			code: "validation_failed",
		});
		await expect(collectKind(client({}), "tok", "repo:bad", [])).rejects.toMatchObject({
			code: "validation_failed",
		});
	});

	it("collects issues and pull requests", async () => {
		const gh = client({
			graphql: (query, vars) => {
				if (query.includes("PullRequest")) {
					return {
						search: {
							issueCount: 1,
							pageInfo: { hasNextPage: false },
							nodes: [
								{
									__typename: "PullRequest",
									number: 2,
									title: "pr",
									additions: 1,
									deletions: 1,
									repository: { nameWithOwner: "o/n" },
								},
							],
						},
					};
				}
				if (vars.after) {
					return { search: { issueCount: 1, pageInfo: { hasNextPage: false }, nodes: [] } };
				}
				return {
					search: {
						issueCount: 1,
						pageInfo: { hasNextPage: true, endCursor: "c" },
						nodes: [issueNode],
					},
				};
			},
		});
		expect(
			(
				(
					await collectKind(
						gh,
						"tok",
						"issues",
						Array.from({ length: 21 }, (_, i) => `o/r${i}`),
					)
				).issues as unknown[]
			).length,
		).toBeGreaterThanOrEqual(0);
		const issues = await collectKind(gh, "tok", "issues", ["o/n"]);
		expect((issues.issues as unknown[]).length).toBeGreaterThan(0);
		const prs = await collectKind(gh, "tok", "prs", ["o/n"]);
		expect((prs.pull_requests as unknown[])[0]).toMatchObject({ number: 2 });
	});

	it("truncates search when total exceeds collected or cap hits", async () => {
		const missing = client({ graphql: () => ({}) });
		expect((await collectKind(missing, "tok", "issues", ["o/n"])).truncated).toBe(true);
		const over = client({
			graphql: () => ({
				search: { issueCount: 5, pageInfo: { hasNextPage: false }, nodes: [issueNode] },
			}),
		});
		expect((await collectKind(over, "tok", "issues", ["o/n"])).truncated).toBe(true);
		const thousand = client({
			graphql: () => ({
				search: { issueCount: 1001, pageInfo: { hasNextPage: false }, nodes: [issueNode] },
			}),
		});
		expect((await collectKind(thousand, "tok", "issues", ["o/n"])).truncated).toBe(true);
		const cap = client({
			graphql: async () => {
				throw new TruncatedError();
			},
		});
		expect((await collectKind(cap, "tok", "prs", ["o/n"])).truncated).toBe(true);
		const forbidden = client({
			graphql: async () => {
				throw new ApiError(403, "github_forbidden", "no");
			},
		});
		await expect(collectKind(forbidden, "tok", "issues", ["o/n"])).rejects.toMatchObject({
			code: "github_forbidden",
		});
		const http404 = client({
			graphql: async () => {
				throw new ApiError(404, "not_found", "no");
			},
		});
		await expect(collectKind(http404, "tok", "prs", ["o/n"])).rejects.toMatchObject({
			code: "not_found",
		});
		const hard = client({
			graphql: async () => {
				throw new ApiError(401, "github_unauthorized", "no");
			},
		});
		await expect(collectKind(hard, "tok", "issues", ["o/n"])).rejects.toMatchObject({
			code: "github_unauthorized",
		});
	});

	it("collects alerts across graphql and rest", async () => {
		const gh = client({
			graphql: (_q, vars) => {
				if (!vars.after) {
					return {
						repository: {
							vulnerabilityAlerts: {
								pageInfo: { hasNextPage: true, endCursor: "c" },
								nodes: [
									{
										securityAdvisory: { summary: "s", permalink: "u" },
										securityVulnerability: { severity: "HIGH" },
									},
								],
							},
						},
					};
				}
				return {
					repository: {
						vulnerabilityAlerts: { pageInfo: { hasNextPage: false }, nodes: [] },
					},
				};
			},
			api: () =>
				Response.json([
					{ rule: { description: "x", security_severity_level: "low" }, html_url: "h" },
				]),
		});
		const out = await collectKind(gh, "tok", "alerts", ["b/n", "a/n"]);
		expect(out.unavailable).toBe(false);
		expect((out.items as unknown[]).length).toBeGreaterThan(0);
		const empty = await collectKind(
			client({
				graphql: () => ({ repository: null }),
				api: async () => {
					throw new ApiError(403, "github_forbidden", "no");
				},
			}),
			"tok",
			"alerts",
			["o/n"],
		);
		expect(empty.unavailable).toBe(true);
		expect(empty.truncated).toBe(true);
		const many = Array.from({ length: 11 }, (_, i) => `o/r${i}`);
		const truncated = await collectKind(
			client({
				graphql: () => ({ repository: { vulnerabilityAlerts: { nodes: [] } } }),
				api: () => Response.json([]),
			}),
			"tok",
			"alerts",
			many,
		);
		expect(truncated.truncated).toBe(true);
	});

	it("skips alert repos on soft errors and rethrows hard ones", async () => {
		const soft = client({
			graphql: async () => {
				throw new ApiError(404, "not_found", "no");
			},
			api: async () => {
				throw new TruncatedError();
			},
		});
		expect((await collectKind(soft, "tok", "alerts", ["o/n"])).truncated).toBe(true);
		const capGql = client({
			graphql: async () => {
				throw new TruncatedError();
			},
			api: () => Response.json([]),
		});
		expect((await collectKind(capGql, "tok", "alerts", ["o/n"])).truncated).toBe(true);
		const hardGql = client({
			graphql: async () => {
				throw new ApiError(401, "github_unauthorized", "no");
			},
		});
		await expect(collectKind(hardGql, "tok", "alerts", ["o/n"])).rejects.toMatchObject({
			code: "github_unauthorized",
		});
		const hardRest = client({
			graphql: () => ({ repository: { vulnerabilityAlerts: { nodes: [] } } }),
			api: async () => {
				throw new ApiError(401, "github_unauthorized", "no");
			},
		});
		await expect(collectKind(hardRest, "tok", "alerts", ["o/n"])).rejects.toMatchObject({
			code: "github_unauthorized",
		});
	});

	it("pages notifications", async () => {
		let n = 0;
		const gh = client({
			api: (path) => {
				n += 1;
				if (path.includes("page=2")) {
					return Response.json([{ id: "2", unread: false, repository: { full_name: "o/n" } }]);
				}
				return new Response(JSON.stringify([{ id: "1", unread: true, subject: { title: "t" } }]), {
					headers: { link: '<https://api.github.com/notifications?page=2>; rel="next"' },
				});
			},
		});
		const out = await collectKind(gh, "tok", "notifications", []);
		expect((out.notifications as unknown[]).length).toBe(2);
		expect(n).toBe(2);
		const cap = client({
			api: async () => {
				throw new TruncatedError();
			},
		});
		expect((await collectKind(cap, "tok", "notifications", [])).truncated).toBe(true);
		const hard = client({
			api: async () => {
				throw new ApiError(401, "github_unauthorized", "no");
			},
		});
		await expect(collectKind(hard, "tok", "notifications", [])).rejects.toMatchObject({
			code: "github_unauthorized",
		});
	});

	it("collects single-repo kinds", async () => {
		const gh = client({
			api: (path) => {
				if (path.endsWith("/o/n")) {
					return Response.json({
						description: "d",
						default_branch: "main",
						archived: false,
						open_issues_count: 1,
						stargazers_count: 2,
						forks_count: 3,
						html_url: "u",
					});
				}
				if (path.includes("/actions/runs")) {
					return Response.json({ workflow_runs: [{ id: 1, name: "ci", status: "completed" }] });
				}
				if (path.includes("/traffic/views")) {
					return Response.json({ count: 1, uniques: 1, views: [] });
				}
				if (path.includes("/traffic/clones")) {
					return Response.json({ count: 2, uniques: 1, clones: [] });
				}
				if (path.includes("/releases")) {
					return Response.json([{ id: 1, tag_name: "v1" }]);
				}
				if (path.includes("/languages")) {
					return Response.json({ TypeScript: 10 });
				}
				if (path.includes("/contributors")) {
					return Response.json([{ login: "a", contributions: 1 }]);
				}
				return Response.json([]);
			},
			graphql: () => ({
				search: { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
				repository: { vulnerabilityAlerts: { nodes: [{ id: "1" }] } },
			}),
		});
		expect((await collectKind(gh, "tok", "repo:o/n:details", [])).default_branch).toBe("main");
		expect(((await collectKind(gh, "tok", "repo:o/n:actions", [])).runs as unknown[]).length).toBe(
			1,
		);
		expect(
			(
				(
					await collectKind(
						client({ api: () => Response.json({ ok: true }) }),
						"tok",
						"repo:o/n:actions",
						[],
					)
				).runs as unknown[]
			).length,
		).toBe(0);
		expect((await collectKind(gh, "tok", "repo:o/n:traffic", [])).forbidden).toBe(false);
		expect((await collectKind(gh, "tok", "repo:o/n:security", [])).unavailable).toBe(false);
		const nextScan = client({
			api: () =>
				new Response("[]", {
					headers: {
						link: '<https://api.github.com/repos/o/n/code-scanning/alerts?page=2>; rel="next"',
					},
				}),
			graphql: () => ({ repository: { vulnerabilityAlerts: { nodes: [] } } }),
		});
		expect((await collectKind(nextScan, "tok", "alerts", ["o/n"])).truncated).toBe(true);
		const forbiddenSec = client({
			graphql: async () => {
				forbiddenSec.graphqlErrors = [{ type: "FORBIDDEN" }];
				return { repository: { vulnerabilityAlerts: { nodes: [{ id: "1" }] } } };
			},
			api: () => Response.json([]),
		});
		expect((await collectKind(forbiddenSec, "tok", "repo:o/n:security", [])).unavailable).toBe(
			true,
		);
		expect((await collectKind(gh, "tok", "repo:o/n:issues", [])).issues).toEqual([]);
		expect((await collectKind(gh, "tok", "repo:o/n:prs", [])).pull_requests).toEqual([]);
		expect(
			((await collectKind(gh, "tok", "repo:o/n:releases", [])).releases as unknown[])[0],
		).toMatchObject({
			tag_name: "v1",
		});
		expect((await collectKind(gh, "tok", "repo:o/n:languages", [])).languages).toEqual({
			TypeScript: 10,
		});
		expect(
			((await collectKind(gh, "tok", "repo:o/n:contributors", [])).contributors as unknown[])
				.length,
		).toBe(1);
	});

	it("writes forbidden and unavailable snapshots for traffic and security", async () => {
		const forbidden = client({
			api: async () => {
				throw new ApiError(403, "github_forbidden", "no");
			},
			graphql: async () => {
				throw new ApiError(403, "github_forbidden", "no");
			},
		});
		expect((await collectKind(forbidden, "tok", "repo:o/n:traffic", [])).forbidden).toBe(true);
		expect((await collectKind(forbidden, "tok", "repo:o/n:security", [])).unavailable).toBe(true);
		const missing = client({
			graphql: () => ({ repository: null }),
			api: async () => {
				throw new ApiError(404, "not_found", "no");
			},
		});
		expect((await collectKind(missing, "tok", "repo:o/n:security", [])).unavailable).toBe(true);
		const cap = client({
			api: async () => {
				throw new TruncatedError();
			},
			graphql: async () => {
				throw new TruncatedError();
			},
		});
		expect((await collectKind(cap, "tok", "repo:o/n:traffic", [])).truncated).toBe(true);
		expect((await collectKind(cap, "tok", "repo:o/n:security", [])).truncated).toBe(true);
		expect((await collectKind(cap, "tok", "repo:o/n:actions", [])).truncated).toBe(true);
		const hard = client({
			api: async () => {
				throw new ApiError(401, "github_unauthorized", "no");
			},
			graphql: async () => {
				throw new ApiError(401, "github_unauthorized", "no");
			},
		});
		await expect(collectKind(hard, "tok", "repo:o/n:traffic", [])).rejects.toMatchObject({
			code: "github_unauthorized",
		});
		await expect(collectKind(hard, "tok", "repo:o/n:security", [])).rejects.toMatchObject({
			code: "github_unauthorized",
		});
		await expect(collectKind(hard, "tok", "repo:o/n:details", [])).rejects.toMatchObject({
			code: "github_unauthorized",
		});
		await expect(collectKind(hard, "tok", "repo:o/n:actions", [])).rejects.toMatchObject({
			code: "github_unauthorized",
		});
		const gqlErr = client({
			graphql: async () => ({
				search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
			}),
		});
		gqlErr.graphqlErrors = [{ type: "NOT_FOUND" }];
		gqlErr.githubGraphql = async () => {
			gqlErr.graphqlErrors = [{ type: "NOT_FOUND" }];
			return { search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } } };
		};
		await expect(collectKind(gqlErr, "tok", "repo:o/n:issues", [])).rejects.toMatchObject({
			code: "not_found",
		});
		gqlErr.githubGraphql = async () => {
			gqlErr.graphqlErrors = [{ type: "FORBIDDEN" }];
			return { search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } } };
		};
		await expect(collectKind(gqlErr, "tok", "repo:o/n:prs", [])).rejects.toMatchObject({
			code: "github_forbidden",
		});
		const labeled = client({
			graphql: () => ({
				search: {
					issueCount: 1,
					pageInfo: { hasNextPage: false },
					nodes: [
						{
							__typename: "Issue",
							number: 1,
							labels: { pageInfo: { hasNextPage: true }, nodes: [] },
							repository: { nameWithOwner: "o/n" },
						},
					],
				},
			}),
		});
		expect((await collectKind(labeled, "tok", "issues", ["o/n"])).truncated).toBe(true);
		const softGql = client({});
		softGql.githubGraphql = async () => {
			softGql.graphqlErrors = [{ type: "FORBIDDEN" }];
			return {
				search: {
					issueCount: 0,
					pageInfo: { hasNextPage: false },
					nodes: [1, { __typename: "Issue", number: 1, repository: { nameWithOwner: "o/n" } }],
				},
			};
		};
		expect((await collectKind(softGql, "tok", "issues", ["o/n"])).truncated).toBe(true);
	});

	it("pages security alerts and ignores scanning soft errors", async () => {
		let gql = 0;
		const gh = client({
			graphql: () => {
				gql += 1;
				if (gql === 1) {
					return {
						repository: {
							vulnerabilityAlerts: {
								pageInfo: { hasNextPage: true, endCursor: "c" },
								nodes: [{ id: "1" }],
							},
						},
					};
				}
				return {
					repository: { vulnerabilityAlerts: { pageInfo: { hasNextPage: false }, nodes: [] } },
				};
			},
			api: async () => {
				throw new ApiError(403, "github_forbidden", "no");
			},
		});
		const out = await collectKind(gh, "tok", "repo:o/n:security", []);
		expect(out.dependabot_open).toBe(1);
		expect(out.truncated).toBe(true);
		const emptyAlerts = await collectKind(
			client({
				graphql: () => ({ repository: { vulnerabilityAlerts: {} } }),
				api: () => Response.json({ not: "array" }),
			}),
			"tok",
			"repo:o/n:security",
			[],
		);
		expect(emptyAlerts.dependabot_open).toBe(0);
		expect(emptyAlerts.code_scanning_open).toBe(0);
		const capScan = client({
			graphql: () => ({ repository: { vulnerabilityAlerts: { nodes: [] } } }),
			api: async () => {
				throw new TruncatedError();
			},
		});
		expect((await collectKind(capScan, "tok", "repo:o/n:security", [])).truncated).toBe(true);
		const hardScan = client({
			graphql: () => ({ repository: { vulnerabilityAlerts: { nodes: [] } } }),
			api: async () => {
				throw new ApiError(401, "github_unauthorized", "no");
			},
		});
		await expect(collectKind(hardScan, "tok", "repo:o/n:security", [])).rejects.toMatchObject({
			code: "github_unauthorized",
		});
	});
});
