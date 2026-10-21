import { expect, it } from "vitest";
import { github } from "../../../../../tests/fixtures/factory";
import { collectKind, collectRepos } from "./collect";

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
