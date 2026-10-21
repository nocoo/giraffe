import { expect, it } from "vitest";
import { github } from "../../../../../tests/fixtures/factory";
import { collectKind, collectRepos } from "./collect";

it.each([null, 7, [], false, "invalid"])("rejects invalid REST list element %j", async (row) => {
	expect(
		await collectKind(
			github(() => Response.json([row])),
			"test",
			"repo:a/b:contributors",
			[],
		),
	).toMatchObject({ truncated: true });
});

it("keeps empty lists and records with nullable optional metadata complete", async () => {
	for (const rows of [[], [{ login: "a", contributions: 1, avatar_url: null }]]) {
		const result = await collectKind(
			github(() => Response.json(rows)),
			"test",
			"repo:a/b:contributors",
			[],
		);
		expect(result.truncated).toBe(false);
		expect(result.contributors).toHaveLength(rows.length);
	}
});

it.each(["issues", "repo:a/b:issues", "repo:a/b:prs", "repo:a/b:security"])(
	"rejects non-string %s continuation before accepting a later terminal page",
	async (kind) => {
		let pages = 0;
		const gh = github((url) => {
			if (!url.endsWith("/graphql")) return Response.json([]);
			pages++;
			const connection = {
				nodes: [],
				issueCount: 0,
				pageInfo: { hasNextPage: pages === 1, endCursor: 7 },
			};
			return Response.json({
				data: { search: connection, repository: { vulnerabilityAlerts: connection } },
			});
		});
		expect(await collectKind(gh, "test", kind, ["a/b"])).toMatchObject({ truncated: true });
		expect(pages).toBe(1);
	},
);

it.each(["repo:a/b:issues", "repo:a/b:prs"])(
	"requires an explicit first-page access error for unavailable %s",
	async (kind) => {
		for (const type of ["FORBIDDEN", "NOT_FOUND"]) {
			const denied = github(() =>
				Response.json({
					data: { search: null },
					errors: [{ type, path: ["search"] }],
				}),
			);
			await expect(collectKind(denied, "test", kind, [])).rejects.toMatchObject({
				code: type === "NOT_FOUND" ? "not_found" : "github_forbidden",
			});
		}
		const malformed = github(() => Response.json({ data: { search: {} } }));
		expect(await collectKind(malformed, "test", kind, [])).toMatchObject({ truncated: true });
	},
);

it.each(["issues", "prs", "repo:a/b:issues", "repo:a/b:prs"])(
	"keeps %s interrupted search pages incomplete for HTTP and GraphQL denial",
	async (kind) => {
		for (const denial of ["http", "graphql", "malformed"]) {
			const gh = github((_url, init) => {
				const { variables } = JSON.parse(String(init?.body));
				if (variables.after)
					return denial === "http"
						? Response.json({ message: "Not Found" }, { status: 404 })
						: Response.json({
								data: { search: {} },
								...(denial === "graphql"
									? {
											errors: [{ type: "FORBIDDEN", path: ["search"] }],
										}
									: {}),
							});
				return Response.json({
					data: {
						search: {
							issueCount: 0,
							nodes: [],
							pageInfo: { hasNextPage: true, endCursor: "next" },
						},
					},
				});
			});
			expect(await collectKind(gh, "test", kind, ["a/b"])).toMatchObject({ truncated: true });
			expect(gh.count).toBe(2);
		}
	},
);

it.each(["repo:a/b:actions", "repo:a/b:releases", "repo:a/b:contributors", "notifications"])(
	"distinguishes first-page access denial from interrupted %s pagination",
	async (kind) => {
		for (const status of [403, 404]) {
			const response = () => Response.json({ message: "private diagnostics" }, { status });
			await expect(collectKind(github(response), "test", kind, [])).rejects.toMatchObject({
				code: status === 403 ? "github_forbidden" : "not_found",
			});
			const gh = github((url) =>
				new URL(url).searchParams.has("page")
					? response()
					: Response.json(kind.endsWith("actions") ? { workflow_runs: [] } : [], {
							headers: { link: `<${url}&page=2>; rel="next"` },
						}),
			);
			expect(await collectKind(gh, "test", kind, [])).toMatchObject({ truncated: true });
			expect(gh.count).toBe(2);
		}
	},
);

it("does not treat malformed notifications as a successful empty list", async () => {
	expect(
		await collectKind(
			github(() => Response.json({})),
			"test",
			"notifications",
			[],
		),
	).toMatchObject({ truncated: true });
});

it("keeps interrupted catalog pages incomplete even if the first page was empty", async () => {
	const gh = github((_url, init) => {
		const { variables } = JSON.parse(String(init?.body));
		return variables.after
			? Response.json({}, { status: 403 })
			: Response.json({
					data: {
						viewer: {
							repositories: {
								nodes: [],
								pageInfo: { hasNextPage: true, endCursor: "next" },
							},
						},
					},
				});
	});
	expect(await collectRepos(gh, "test")).toMatchObject({ truncated: true });
});
