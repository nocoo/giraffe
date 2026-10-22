import { expect, it } from "vitest";
import { github, rawRepo } from "../../../../../tests/fixtures/factory";
import { makeRun } from "../../lib/factory-run";
import type { FactoryStreamData } from "../../lib/factory-types";
import { completeActivity } from "./activity";
import {
	type ActivitySupplement,
	collectActivityContributions,
	collectActivitySupplement,
} from "./activity-collect";
import { newFactory } from "./factory-collect";
import { mapFactoryRepo } from "./factory-map";

const now = "2026-10-22T20:00:00.000Z";
const repo = mapFactoryRepo(rawRepo);
function run() {
	return {
		...makeRun(
			"edge",
			"account_123",
			"nocoo",
			"key",
			"refresh",
			[],
			now,
			[],
			[],
			{ scope: "all" },
			"quick",
		),
		activityWindow: { since: "2026-10-21T20:00:00.000Z", until: now, gap: false, first: false },
		checkpoint: newFactory("account_123", "nocoo", now),
	};
}
function connection(nodes: unknown[] = [], endCursor?: string) {
	return { nodes, pageInfo: { hasNextPage: endCursor !== undefined, endCursor } };
}
function state(phase: ActivitySupplement["phase"]): ActivitySupplement {
	return {
		phase,
		commits: [],
		tags: [],
		last_success_at: null,
		coverage: {
			other_commits: completeActivity(),
			tags: completeActivity(),
			deploy: completeActivity(),
		},
		after: null,
		tagAfter: null,
		pending: [],
		deployNext: null,
		pages: 1,
	};
}
function result(repository: unknown) {
	return Response.json({ data: { repository } });
}
const commit = (sha: string) => ({ oid: sha, committedDate: now });

it.each([{}, { repository: {} }, { repository: { refs: {} } }])(
	"R4 refuses missing initial branch evidence %j",
	async (data) => {
		const gh = github(() => Response.json({ data }));
		const output = await collectActivitySupplement(run(), repo, gh, "fake", null);
		expect(output.done).toBe(true);
		expect(output.state.commits).toBeNull();
		expect(output.state.coverage.other_commits?.status).toBe("unavailable");
	},
);

it("R4 missing tags do not erase independently observed branch evidence", async () => {
	const gh = github(() => result({ refs: connection() }));
	const output = await collectActivitySupplement(run(), repo, gh, "fake", null);
	expect(output.state.coverage.tags?.status).toBe("unavailable");
	expect(output.state.coverage.other_commits?.status).toBe("complete");
	expect(output.state.phase).toBe("deploy");
});

it.each([undefined, "", "repeat"])(
	"R4 rejects invalid or repeated refs cursor %s",
	async (endCursor) => {
		const previous = state("refs");
		previous.after = "repeat";
		const gh = github(() =>
			result({ refs: { nodes: [], pageInfo: { hasNextPage: true, endCursor } } }),
		);
		await expect(
			collectActivitySupplement(run(), repo, gh, "fake", previous),
		).rejects.toMatchObject({ code: "github_error" });
	},
);

it.each(["tags", "commits"] as const)("R4 rejects repeated %s cursors", async (phase) => {
	const previous = state(phase);
	previous.tagAfter = "repeat";
	previous.pending = [{ branch: "feature", sha: "head", after: "repeat" }];
	const next = connection([], "repeat");
	const gh = github(() =>
		result(phase === "tags" ? { tags: next } : { object: { history: next } }),
	);
	await expect(collectActivitySupplement(run(), repo, gh, "fake", previous)).rejects.toMatchObject({
		code: "github_error",
	});
});

it("R4 paginates branch history with SHA deduplication and nullable authors", async () => {
	const previous = state("commits");
	previous.pending = [{ branch: "feature", sha: "head", after: "first" }];
	previous.last_success_at = now;
	const current = run();
	const gh = github((_url, init) => {
		const variables = JSON.parse(String(init?.body)).variables;
		expect(variables.sha).toBe("head");
		return Response.json({
			data: {
				repository: {
					object: {
						history:
							variables.after === "first"
								? connection(
										[commit("one"), commit("one"), { oid: "old", committedDate: "2000-01-01" }],
										"second",
									)
								: connection([commit("one"), commit("two")]),
					},
				},
				rateLimit: { remaining: 4555 },
			},
		});
	});
	const first = await collectActivitySupplement(current, repo, gh, "fake", previous);
	expect(first.done).toBe(false);
	const second = await collectActivitySupplement(current, repo, gh, "fake", first.state);
	expect(second.done).toBe(true);
	expect(second.state.commits?.map((item) => item.sha)).toEqual(["one", "two"]);
	expect(second.state.commits?.[0]).toMatchObject({ author: null, message: "", url: "" });
	expect(current.checkpoint.rateLimits?.graphql).toMatchObject({ remaining: 4555, resetAt: null });
});

it("R4 missing branch history is retryable rather than successful empty", async () => {
	const previous = state("commits");
	previous.pending = [{ branch: "feature", sha: "head", after: "next" }];
	await expect(
		collectActivitySupplement(
			run(),
			repo,
			github(() => result({ object: {} })),
			"fake",
			previous,
		),
	).rejects.toMatchObject({ code: "github_error" });
});

it("R4 graphQL permission errors cannot claim complete supplemental evidence", async () => {
	const gh = github(() =>
		Response.json({
			data: { repository: { refs: connection(), tags: connection() } },
			errors: [{ type: "FORBIDDEN", path: ["repository", "refs"] }],
		}),
	);
	const output = await collectActivitySupplement(run(), repo, gh, "fake", null);
	expect(output.state.coverage.other_commits?.status).toBe("unavailable");
});

it.each([403, 404])("R4 %s marks denied branch and deploy evidence unavailable", async (status) => {
	for (const phase of ["refs", "commits", "deploy"] as const) {
		const previous = state(phase);
		previous.pending = [{ branch: "feature", sha: "head", after: "next" }];
		const output = await collectActivitySupplement(
			run(),
			repo,
			github(() => Response.json({ message: "denied" }, { status })),
			"fake",
			previous,
		);
		expect(output.done).toBe(true);
		expect(output.state.coverage[phase === "deploy" ? "deploy" : "other_commits"]?.status).toBe(
			"unavailable",
		);
	}
});

it("R4 malformed deployment lists and server errors remain retryable", async () => {
	for (const response of [Response.json({}), Response.json({}, { status: 500 })]) {
		await expect(
			collectActivitySupplement(
				run(),
				repo,
				github(() => response),
				"fake",
				state("deploy"),
			),
		).rejects.toMatchObject({ code: "github_error" });
	}
});

it("R4 deployment pagination skips unrelated successes and preserves newest observed deployment", async () => {
	const previous = state("deploy");
	previous.last_success_at = now;
	let requests = 0;
	const gh = github((url) => {
		requests++;
		if (requests === 1)
			return Response.json(
				{ workflow_runs: [{ id: 1, name: "Unit", conclusion: "success", created_at: now }] },
				{
					headers: {
						link: '<https://api.github.com/repos/nocoo/app/actions/runs?status=success&per_page=100&page=2>; rel="next"',
					},
				},
			);
		expect(url).toContain("page=2");
		return Response.json({
			workflow_runs: [
				{ id: 2, name: "Publish", conclusion: "success", created_at: "2026-10-21T01:00:00Z" },
			],
		});
	});
	const first = await collectActivitySupplement(run(), repo, gh, "fake", previous);
	expect(first.done).toBe(false);
	const second = await collectActivitySupplement(run(), repo, gh, "fake", first.state);
	expect(second.done).toBe(true);
	expect(second.state.last_success_at).toBe(now);
});

it("R4 finished checkpoint requires no requests", async () => {
	const gh = github(() => {
		throw new Error("unexpected request");
	});
	expect((await collectActivitySupplement(run(), repo, gh, "fake", state("done"))).done).toBe(true);
	expect(gh.count).toBe(0);
});

it.each(["items", "bytes"])(
	"R4 bounds supplemental %s without claiming complete coverage",
	async (limit) => {
		const previous = state("tags");
		previous.commits = Array.from({ length: limit === "items" ? 5001 : 3000 }, (_, index) => ({
			sha: `sha-${index}`,
			author: null,
			message: "界".repeat(limit === "bytes" ? 200 : 1),
			at: now,
			url: "",
			branch: "feature",
			is_default_branch: false,
		}));
		const gh = github(() => result({ tags: connection([], "next") }));
		const output = await collectActivitySupplement(run(), repo, gh, "fake", previous);
		expect(output.done).toBe(true);
		expect(output.state.coverage.other_commits).toMatchObject({
			status: "partial",
			truncated: true,
		});
		expect(output.state.commits?.length).toBeLessThanOrEqual(5000);
		expect(new TextEncoder().encode(JSON.stringify(output.state)).length).toBeLessThanOrEqual(
			1_200_000,
		);
		expect(output.state.pending).toEqual([]);
	},
);

it("R4 invalid native dates and totals remain partial with no invented contribution zero", async () => {
	const gh = github(() =>
		Response.json({
			data: {
				user: {
					day0: {
						totalCommitContributions: 2,
						contributionCalendar: {
							totalContributions: -1,
							weeks: [{ contributionDays: [{ date: "bad", contributionCount: 1 }] }],
						},
					},
					day1: {},
				},
				rateLimit: { remaining: 4500, resetAt: now },
			},
		}),
	);
	const current = run();
	const output = await collectActivityContributions(current, gh, "fake");
	expect(output.days[0]).toMatchObject({
		count: null,
		types: { commits: 2 },
		nativeCalendar: { days: [] },
		coverage: { status: "partial" },
	});
	expect(output.days[1]?.coverage.status).toBe("unavailable");
	expect(current.checkpoint.rateLimits?.graphql?.resetAt).toBe(now);
});

it.each([403, 404])(
	"R4 unavailable contribution endpoint %s preserves unknown days",
	async (status) => {
		const output = await collectActivityContributions(
			run(),
			github(() => Response.json({}, { status })),
			"fake",
		);
		expect(
			output.days.every((day) => day.count === null && day.coverage.status === "unavailable"),
		).toBe(true);
	},
);

it("R4 contribution server failure retries instead of publishing empty days", async () => {
	await expect(
		collectActivityContributions(
			run(),
			github(() => Response.json({}, { status: 500 })),
			"fake",
		),
	).rejects.toMatchObject({ code: "github_error" });
});

it("R4 incomplete actions cannot suppress a deployment lookback", async () => {
	const actions: FactoryStreamData = {
		runId: "edge",
		items: [],
		next: null,
		ranges: [],
		coverage: {
			status: "partial",
			fetchedAt: now,
			reason: "limited",
			pages: 1,
			source: "rest",
			observed: 0,
		},
	};
	const output = await collectActivitySupplement(
		run(),
		repo,
		github(() => result({ refs: connection(), tags: connection() })),
		"fake",
		null,
		actions,
	);
	expect(output.state.phase).toBe("deploy");
});

it.each([null, now])(
	"R4 final tag page independently advances to deployment or completion %s",
	async (lastSuccess) => {
		const previous = state("tags");
		previous.last_success_at = lastSuccess;
		const output = await collectActivitySupplement(
			run(),
			repo,
			github(() => result({ tags: connection() })),
			"fake",
			previous,
		);
		expect(output.state.phase).toBe(lastSuccess ? "done" : "deploy");
		expect(output.state.coverage.tags?.status).toBe("complete");
	},
);

it.each([null, now])(
	"R4 denied tag pagination still resolves independent deployment state %s",
	async (lastSuccess) => {
		const previous = state("tags");
		previous.last_success_at = lastSuccess;
		const output = await collectActivitySupplement(
			run(),
			repo,
			github(() => Response.json({}, { status: 403 })),
			"fake",
			previous,
		);
		expect(output.state.phase).toBe(lastSuccess ? "done" : "deploy");
		expect(output.state.coverage.tags?.status).toBe("unavailable");
	},
);

it("R4 tag-only byte trimming preserves unavailable branch evidence", async () => {
	const previous = state("tags");
	previous.commits = null;
	previous.coverage.other_commits = { status: "unavailable", truncated: false, reason: "denied" };
	previous.tags = Array.from({ length: 3000 }, (_, index) => ({
		id: `tag:${index}`,
		title: "界".repeat(200),
		url: "",
		at: now,
		createdAt: now,
		closedAt: null,
		mergedAt: null,
		author: null,
		state: "tag",
	}));
	const output = await collectActivitySupplement(
		run(),
		repo,
		github(() => result({ tags: connection([], "next") })),
		"fake",
		previous,
	);
	expect(output.done).toBe(true);
	expect(output.state.commits).toBeNull();
	expect(output.state.coverage.other_commits).toEqual(previous.coverage.other_commits);
	expect(output.state.coverage.tags).toMatchObject({ status: "partial", truncated: true });
	expect(output.state.tags?.length).toBeLessThan(3000);
	expect(new TextEncoder().encode(JSON.stringify(output.state)).length).toBeLessThanOrEqual(
		1_200_000,
	);
});

it("R4 resumes branch continuation after tags when deployment success is still unknown", async () => {
	const previous = state("commits");
	previous.pending = [{ branch: "feature", sha: "head", after: "next" }];
	const output = await collectActivitySupplement(
		run(),
		repo,
		github(() => result({ object: { history: connection() } })),
		"fake",
		previous,
	);
	expect(output.done).toBe(false);
	expect(output.state.phase).toBe("deploy");
	expect(output.state.coverage.other_commits?.status).toBe("complete");
});
