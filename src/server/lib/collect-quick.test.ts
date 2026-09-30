import { expect, it } from "vitest";
import { github } from "../../../tests/fixtures/factory";
import { collectKind } from "./collect";
import { MAX_FETCHES } from "./github-client";

const issue = (number: number, state = "OPEN", isPr = false) => ({
	__typename: isPr ? "PullRequest" : "Issue",
	number,
	title: `work ${number}`,
	url: `https://github.com/a/b/${isPr ? "pull" : "issues"}/${number}`,
	repository: { nameWithOwner: "a/b" },
	state,
});

it.each(["issues", "prs", "repo:a/b:issues", "repo:a/b:prs"])(
	"reconciles every current-open page after 101 old records close in %s",
	async (kind) => {
		const isPr = kind.endsWith("prs");
		const key = isPr ? "pull_requests" : "issues";
		const previous = Array.from({ length: 202 }, (_, index) => issue(index + 1, "OPEN", isPr));
		const current = previous.slice(101).map((row) => ({ ...row, title: "updated" }));
		let closed = false;
		const gh = github((_url, init) => {
			const { variables } = JSON.parse(String(init?.body));
			expect(variables.q).toContain("is:open");
			const after = Number(variables.after ?? 0);
			const rows = closed ? current : previous;
			return Response.json({
				data: {
					search: {
						issueCount: rows.length,
						nodes: rows.slice(after, after + 100),
						pageInfo: { hasNextPage: after + 100 < rows.length, endCursor: String(after + 100) },
					},
				},
			});
		});
		expect((await collectKind(gh, "test", kind, ["a/b"], 1_000_000))[key]).toHaveLength(202);
		closed = true;
		const requests = gh.count;
		const result = await collectKind(gh, "test", kind, ["a/b"], 1_000_000);
		expect(result.truncated).toBe(false);
		expect(result[key]).toHaveLength(101);
		expect((result[key] as { number: number }[]).map((row) => row.number)).toEqual(
			current.map((row) => row.number),
		);
		expect((result[key] as { title: string }[]).every((row) => row.title === "updated")).toBe(true);
		expect(gh.count - requests).toBe(2);
	},
);

it.each(["issues", "prs"])("removes deleted %s even when the first page overlaps", async (kind) => {
	const isPr = kind === "prs";
	const key = isPr ? "pull_requests" : "issues";
	let deleted = false;
	const gh = github((_url, init) => {
		const { variables } = JSON.parse(String(init?.body));
		expect(variables.q).toContain("is:open");
		return Response.json({
			data: {
				search: {
					issueCount: 2,
					nodes: [issue(variables.after ? (deleted ? 3 : 2) : 1, "OPEN", isPr)],
					pageInfo: { hasNextPage: !variables.after, endCursor: "next" },
				},
			},
		});
	});
	const baseline = await collectKind(gh, "test", kind, ["a/b"], 100_000);
	expect((baseline[key] as { number: number }[]).map((row) => row.number)).toEqual([1, 2]);
	deleted = true;
	const result = await collectKind(gh, "test", kind, ["a/b"], 100_000);
	expect(result.truncated).toBe(false);
	expect((result[key] as { number: number }[]).map((row) => row.number)).toEqual([1, 3]);
	expect(gh.count).toBe(4);
});

it.each(["actions", "releases", "contributors"])(
	"reconciles %s beyond overlapping pages and removes deleted records",
	async (suffix) => {
		const key = suffix === "actions" ? "runs" : suffix;
		const previous = Array.from({ length: 102 }, (_, index) => ({
			id: index + 1,
			login: `user${index + 1}`,
			name: "old",
			conclusion: "failure",
			contributions: 1,
		}));
		const current = previous.slice(0, 101).map((row) => ({
			...row,
			name: "updated",
			conclusion: "success",
			contributions: 2,
		}));
		const endpoint = suffix === "actions" ? "actions/runs" : suffix;
		let changed = false;
		const gh = github((url) => {
			const second = new URL(url).searchParams.get("page") === "2";
			const source = changed ? current : previous;
			const rows = source.slice(second ? 100 : 0, second ? source.length : 100);
			return Response.json(
				suffix === "actions" ? { total_count: source.length, workflow_runs: rows } : rows,
				{
					headers: second
						? {}
						: { link: `<https://api.github.com/repos/a/b/${endpoint}?page=2>; rel="next"` },
				},
			);
		});
		expect((await collectKind(gh, "test", `repo:a/b:${suffix}`, [], 1_000_000))[key]).toHaveLength(
			102,
		);
		changed = true;
		const result = await collectKind(gh, "test", `repo:a/b:${suffix}`, [], 1_000_000);
		expect(gh.count).toBe(4);
		expect(result.truncated).toBe(false);
		expect(result[key]).toHaveLength(101);
		expect((result[key] as unknown[])[100]).toMatchObject(
			suffix === "actions"
				? { id: 101, conclusion: "success" }
				: suffix === "releases"
					? { id: 101, name: "updated" }
					: { login: "user101", contributions: 2 },
		);
	},
);

it("keeps incomplete open-list results truncated when request or byte caps stop pagination", async () => {
	for (const capped of [true, false]) {
		const gh = github(() =>
			Response.json({
				data: {
					search: {
						issueCount: 2,
						nodes: [issue(1)],
						pageInfo: { hasNextPage: true, endCursor: "next" },
					},
				},
			}),
		);
		if (capped) gh.count = MAX_FETCHES - 1;
		const result = await collectKind(gh, "test", "issues", ["a/b"], capped ? 100_000 : 10);
		expect(result.truncated).toBe(true);
		expect(gh.count).toBe(capped ? MAX_FETCHES : 1);
	}
});

it.each([
	{ issueCount: 0, pageInfo: { hasNextPage: false } },
	{ issueCount: 1, nodes: [issue(1)], pageInfo: { hasNextPage: true } },
])("does not publish incomplete search pages as successful snapshots", async (search) => {
	const gh = github(() => Response.json({ data: { search } }));
	const result = await collectKind(gh, "test", "issues", ["a/b"]);
	expect(result.truncated).toBe(true);
	expect(gh.count).toBe(1);
});

it("rejects a repeated search cursor instead of reporting complete or exhausting the request cap", async () => {
	const gh = github(() =>
		Response.json({
			data: {
				search: {
					issueCount: 3,
					nodes: [issue(1)],
					pageInfo: { hasNextPage: true, endCursor: "same" },
				},
			},
		}),
	);
	expect((await collectKind(gh, "test", "issues", ["a/b"])).truncated).toBe(true);
	expect(gh.count).toBe(2);
});

it.each(["issues", "prs"])(
	"excludes closed or merged %s returned by a stale open search index",
	async (kind) => {
		const isPr = kind === "prs";
		const gh = github(() =>
			Response.json({
				data: {
					search: {
						issueCount: 3,
						nodes: [issue(1, "OPEN", isPr), issue(2, "CLOSED", isPr), issue(3, "MERGED", isPr)],
						pageInfo: { hasNextPage: false },
					},
				},
			}),
		);
		const result = await collectKind(gh, "test", kind, ["a/b"]);
		expect(result.truncated).toBe(false);
		const rows = result[isPr ? "pull_requests" : "issues"] as { number: number }[];
		expect(rows.map((row) => row.number)).toEqual([1]);
	},
);

it.each(["actions", "releases", "contributors"])(
	"does not publish an invalid %s resource list as successful empty data",
	async (suffix) => {
		const gh = github(() => Response.json({}));
		const result = await collectKind(gh, "test", `repo:a/b:${suffix}`, []);
		expect(result.truncated).toBe(true);
	},
);

it("keeps incomplete mutable REST results truncated when the request cap stops pagination", async () => {
	const gh = github(() =>
		Response.json([{ id: 1, name: "updated" }], {
			headers: { link: '<https://api.github.com/repos/a/b/releases?page=2>; rel="next"' },
		}),
	);
	gh.count = MAX_FETCHES - 1;
	const result = await collectKind(gh, "test", "repo:a/b:releases", [], 100_000);
	expect(result.truncated).toBe(true);
	expect(result.releases).toHaveLength(1);
	expect(gh.count).toBe(MAX_FETCHES);
});

it("keeps missing search rows truncated rather than treating them as deletions", async () => {
	const gh = github(() =>
		Response.json({
			data: { search: { issueCount: 2, nodes: [issue(1)], pageInfo: { hasNextPage: false } } },
		}),
	);
	const result = await collectKind(gh, "test", "issues", ["a/b"], 10_000);
	expect(result.truncated).toBe(true);
});
