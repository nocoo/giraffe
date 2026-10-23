import { expect, it, vi } from "vitest";
import { github, NOW, rawRepo } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import type { Env } from "../env";
import { collectKind, MAX_STAGED_BYTES } from "./collect";
import { createDb } from "./db/d1";
import { claimRun, saveRun, startRun } from "./db/factory-runs";
import { readSnapshot } from "./db/snapshots";
import { ApiError } from "./errors";
import { FactoryInvocation, InvocationStopped } from "./factory-invocation";
import { collectSitePage } from "./factory-site";
import { createGithubClient } from "./github-client";
import { mapActionRuns } from "./github-map";

async function setup(resource = "repo:nocoo/app:actions") {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('account','nocoo','encrypted','fake',?,?)",
		)
		.bind(NOW, NOW)
		.run();
	const run = makeRun("site", "account", "nocoo", "request", "refresh", [], NOW, [], ["nocoo/app"]);
	run.cursor = run.steps.findIndex((step) => step.resource === resource);
	await startRun(db, run);
	const lease = await claimRun(db, run.id, NOW);
	const step = lease?.run.steps[run.cursor];
	if (!lease || !step) throw new Error("fixture lease missing");
	return { raw, db, lease, step };
}

function actionPage(index: number, last = 3) {
	return Response.json(
		{ workflow_runs: [{ id: index, name: `Workflow ${index}` }] },
		{
			headers:
				index < last
					? {
							link: `<https://api.github.com/repos/nocoo/app/actions/runs?per_page=100&page=${index + 1}>; rel="next"`,
						}
					: {},
		},
	);
}

it("checkpoints each slow Actions page and finishes without fetching saved pages again", async () => {
	const { db, lease, step } = await setup();
	const paths: string[] = [];
	let wall = 0;
	for (let index = 1; index <= 3; index++) {
		const client = github((url) => {
			paths.push(url);
			wall += 12_000;
			return actionPage(index);
		});
		const result = await collectSitePage(db, lease, step, client, "private-token", NOW);
		expect(client.count).toBe(1);
		expect(wall).toBe(index * 12_000);
		expect(result.done).toBe(index === 3);
		expect(await readSnapshot(db, "account", step.resource ?? "", "site")).toBeNull();
		expect(await saveRun(db, lease, result.writes, NOW, true)).toBe(true);
		const rows = await db.prepare("SELECT payload FROM factory_resources").all();
		expect(JSON.stringify(rows)).not.toContain("private-token");
	}
	expect(paths.map((path) => new URL(path).searchParams.get("page"))).toEqual([null, "2", "3"]);
	expect(await readSnapshot(db, "account", step.resource ?? "", "site")).toMatchObject({
		truncated: false,
		runs: mapActionRuns({ workflow_runs: [1, 2, 3].map((id) => ({ id, name: `Workflow ${id}` })) }),
	});
});

it("preserves committed pages when beforeRequest stops the next invocation", async () => {
	const { db, lease, step } = await setup();
	const first = await collectSitePage(
		db,
		lease,
		step,
		github(() => actionPage(1, 2)),
		"fake",
		NOW,
	);
	expect(first.done).toBe(false);
	expect(await saveRun(db, lease, first.writes, NOW, true)).toBe(true);
	const before = await db.prepare("SELECT * FROM factory_resources ORDER BY stream").all();
	const fetcher = vi.fn(() => Promise.resolve(actionPage(2, 2)));
	const interrupted = createGithubClient(
		{ ENVIRONMENT: "production" } as Env,
		fetcher,
		undefined,
		async () => {
			throw new InvocationStopped();
		},
	);
	await expect(collectSitePage(db, lease, step, interrupted, "fake", NOW)).rejects.toBeInstanceOf(
		InvocationStopped,
	);
	expect(fetcher).not.toHaveBeenCalled();
	expect(await db.prepare("SELECT * FROM factory_resources ORDER BY stream").all()).toEqual(before);
	const requested: string[] = [];
	const final = await collectSitePage(
		db,
		lease,
		step,
		github((url) => {
			requested.push(url);
			return actionPage(2, 2);
		}),
		"fake",
		NOW,
	);
	expect(final.done).toBe(true);
	expect(requested).toHaveLength(1);
	expect(requested[0]).toContain("page=2");
	expect(await saveRun(db, lease, final.writes, NOW)).toBe(true);
	expect((await readSnapshot(db, "account", step.resource ?? "", "site"))?.runs).toHaveLength(2);
});

it("also advances slow GraphQL repository snapshots one new request at a time", async () => {
	const { db, lease, step } = await setup("repos");
	const cursors: unknown[] = [];
	for (let index = 0; index < 2; index++) {
		const client = github((_url, init) => {
			cursors.push(JSON.parse(String(init?.body)).variables.after);
			return Response.json({
				data: {
					viewer: {
						repositories: {
							nodes: [{ ...rawRepo, id: `R_${index}`, nameWithOwner: `nocoo/app${index}` }],
							pageInfo: { hasNextPage: index === 0, endCursor: index === 0 ? "next-page" : null },
						},
					},
				},
			});
		});
		lease.run.mode = "catalog";
		const result = await collectSitePage(db, lease, step, client, "fake", NOW);
		expect(result.done).toBe(index === 1);
		expect(client.count).toBe(1);
		expect(await saveRun(db, lease, result.writes, NOW, true)).toBe(true);
	}
	expect(cursors).toEqual([null, "next-page"]);
});

it("keeps slow startup repository pages through post-fetch processing without waiting for lease expiry", async () => {
	const { raw, lease, step } = await setup("repos");
	lease.run.mode = "catalog";
	let elapsed = 0;
	const clock = () => new Date(Date.parse(NOW) + elapsed).toISOString();
	const cursors: unknown[] = [];
	for (let index = 0; index < 2; index++) {
		const db = createDb(raw);
		const invocation = new FactoryInvocation(db, lease, clock);
		if (index === 0) elapsed = 19_000;
		const client = createGithubClient(
			{ ENVIRONMENT: "production" } as Env,
			async (_url, init) => {
				cursors.push(JSON.parse(String(init?.body)).variables.after);
				elapsed += 15_000;
				return Response.json({
					data: {
						viewer: {
							repositories: {
								nodes: [{ ...rawRepo, id: `R_${index}`, nameWithOwner: `nocoo/app${index}` }],
								pageInfo: {
									hasNextPage: index === 0,
									endCursor: index === 0 ? "next-page" : null,
								},
							},
						},
					},
				});
			},
			undefined,
			() => invocation.beforeRequest(),
		);
		const result = await collectSitePage(db, lease, step, client, "fake", clock(), undefined, () =>
			invocation.heartbeat(),
		);
		elapsed += 7_000;
		expect(await saveRun(db, lease, result.writes, clock(), true)).toBe(true);
		expect(result.done).toBe(index === 1);
		expect(client.count).toBe(1);
		expect(await claimRun(createDb(raw), "site", clock())).toBeNull();
	}
	expect(cursors).toEqual([null, "next-page"]);
	const db = createDb(raw);
	const plan = await db
		.prepare("SELECT payload FROM factory_resources WHERE stream='catalog-plan'")
		.first<{ payload: string }>();
	expect(JSON.parse(plan?.payload ?? "{}").rows).toHaveLength(2);
	expect(
		await db
			.prepare(
				"SELECT count(*) AS total FROM factory_resources WHERE stream LIKE 'snapshot-replay:%'",
			)
			.first(),
	).toEqual({ total: 0 });
});

it("keeps upstream errors and fencing instead of treating them as a successful page", async () => {
	for (const error of [
		new ApiError(503, "github_rate_limited", "limited"),
		new InvocationStopped(true),
	]) {
		const { db, lease, step } = await setup();
		await expect(
			collectSitePage(
				db,
				lease,
				step,
				github(() => {
					throw error;
				}),
				"fake",
				NOW,
			),
		).rejects.toBe(error);
		expect(await db.prepare("SELECT count(*) AS total FROM factory_resources").first()).toEqual({
			total: 0,
		});
	}
});

it("resumes under a new lease after losing an uncommitted page", async () => {
	const { raw, db, lease, step } = await setup();
	const first = await collectSitePage(
		db,
		lease,
		step,
		github(() => actionPage(1)),
		"fake",
		NOW,
	);
	expect(await saveRun(db, lease, first.writes, NOW, true)).toBe(true);
	const abandoned = await collectSitePage(
		db,
		lease,
		step,
		github(() => actionPage(2)),
		"fake",
		NOW,
	);
	const later = new Date(Date.parse(NOW) + 120_000).toISOString();
	const replacementDb = createDb(raw);
	const replacement = await claimRun(replacementDb, "site", later);
	const replacementStep = replacement?.run.steps[replacement.run.cursor];
	if (!replacement || !replacementStep) throw new Error("replacement lease missing");
	expect(await saveRun(db, lease, abandoned.writes, later)).toBe(false);
	const paths: string[] = [];
	const resumed = await collectSitePage(
		replacementDb,
		replacement,
		replacementStep,
		github((url) => {
			paths.push(url);
			return actionPage(2);
		}),
		"fake",
		later,
	);
	expect(paths).toHaveLength(1);
	expect(paths[0]).toContain("page=2");
	expect(resumed.done).toBe(false);
	expect(await saveRun(replacementDb, replacement, resumed.writes, later, true)).toBe(true);
	const final = await collectSitePage(
		replacementDb,
		replacement,
		replacementStep,
		github(() => actionPage(3)),
		"fake",
		later,
	);
	expect(final.done).toBe(true);
	expect(await saveRun(replacementDb, replacement, final.writes, later)).toBe(true);
	expect(
		(await readSnapshot(replacementDb, "account", step.resource ?? "", "site"))?.runs,
	).toHaveLength(3);
	expect(
		await replacementDb
			.prepare(
				"SELECT count(*) AS total FROM factory_resources WHERE stream LIKE 'snapshot-replay:%'",
			)
			.first(),
	).toEqual({ total: 0 });
});

it.each([
	"repo:nocoo/app:actions",
	"repo:nocoo/app:releases",
	"repo:nocoo/app:contributors",
	"notifications",
	"issues",
	"prs",
	"repo:nocoo/app:issues",
	"repo:nocoo/app:prs",
	"repo:nocoo/app:traffic",
	"repo:nocoo/app:security",
	"alerts",
])("matches the existing collector output for paginated %s", async (resource) => {
	const { raw, lease, step } = await setup(resource);
	const handler: Parameters<typeof github>[0] = (url, init) => {
		if (url.endsWith("/graphql")) {
			const request = JSON.parse(String(init?.body));
			const index = request.variables.after ? 2 : 1;
			const pageInfo = { hasNextPage: index === 1, endCursor: index === 1 ? "second" : null };
			if (request.query.includes("vulnerabilityAlerts"))
				return Response.json({
					data: {
						repository: {
							vulnerabilityAlerts: {
								nodes: [
									{
										id: `A_${index}`,
										securityAdvisory: { summary: `Alert ${index}` },
										securityVulnerability: { severity: "HIGH" },
									},
								],
								pageInfo,
							},
						},
					},
				});
			return Response.json({
				data: {
					search: {
						issueCount: 2,
						pageInfo,
						nodes: [
							{
								__typename: resource.endsWith("prs") ? "PullRequest" : "Issue",
								number: index,
								title: `Item ${index}`,
								state: "OPEN",
								repository: { nameWithOwner: "nocoo/app" },
								labels: { nodes: [], pageInfo: { hasNextPage: false } },
							},
						],
					},
				},
			});
		}
		if (url.includes("/traffic/"))
			return Response.json({ count: 2, uniques: 1, views: [], clones: [] });
		if (url.includes("/code-scanning/")) return Response.json([]);
		const index = new URL(url).searchParams.has("page") ? 2 : 1;
		const items = [
			{
				id: index,
				name: `Item ${index}`,
				login: `user${index}`,
				contributions: index,
				tag_name: `v${index}`,
				subject: { title: `Notice ${index}`, type: "Issue" },
				repository: { full_name: "nocoo/app" },
			},
		];
		const next = new URL(url);
		next.searchParams.set("page", "2");
		return Response.json(resource.endsWith(":actions") ? { workflow_runs: items } : items, {
			headers: index === 1 ? { link: `<${next}>; rel="next"` } : {},
		});
	};
	const baseline = await collectKind(github(handler), "fake", resource, ["nocoo/app"]);
	expect(baseline.truncated).toBe(false);
	let completed = false;
	for (let attempt = 0; attempt < 4; attempt++) {
		const db = createDb(raw);
		const client = github(handler);
		const result = await collectSitePage(db, lease, step, client, "fake", NOW);
		expect(client.count).toBe(1);
		expect(await saveRun(db, lease, result.writes, NOW, true)).toBe(true);
		if (result.done) {
			completed = true;
			break;
		}
	}
	expect(completed).toBe(true);
	expect(await readSnapshot(createDb(raw), "account", resource, "site")).toMatchObject({
		...baseline,
		fetched_at: NOW,
	});
});

it("fails closed at the logical request limit instead of yielding forever across fresh clients", async () => {
	const { raw, lease, step } = await setup();
	let requests = 0;
	for (let index = 1; index <= 40; index++) {
		const db = createDb(raw);
		const client = github(() => {
			requests++;
			return actionPage(index, 41);
		});
		const work = collectSitePage(db, lease, step, client, "fake", NOW);
		if (index === 40) await expect(work).rejects.toMatchObject({ code: "snapshot_incomplete" });
		else {
			const result = await work;
			expect(result.done).toBe(false);
			expect(await saveRun(db, lease, result.writes, NOW, true)).toBe(true);
		}
	}
	expect(requests).toBe(40);
	expect(await readSnapshot(createDb(raw), "account", step.resource ?? "", "site")).toBeNull();
});

it("does not apply replay storage limits to a terminal response that needs no checkpoint", async () => {
	const { db, lease, step } = await setup();
	const result = await collectSitePage(
		db,
		lease,
		step,
		github(() =>
			Response.json({
				workflow_runs: [{ id: 1, ignored: "x".repeat(MAX_STAGED_BYTES) }],
			}),
		),
		"fake",
		NOW,
	);
	expect(result.done).toBe(true);
	expect(await saveRun(db, lease, result.writes, NOW)).toBe(true);
	expect((await readSnapshot(db, "account", step.resource ?? "", "site"))?.runs).toEqual(
		mapActionRuns({ workflow_runs: [{ id: 1 }] }),
	);
});

it("preserves small release projections across more than 16 MiB of raw paginated responses", async () => {
	const { raw, lease, step } = await setup("repo:nocoo/app:releases");
	let requests = 0;
	for (let index = 1; index <= 7; index++) {
		const db = createDb(raw);
		const client = github(() => {
			requests++;
			return Response.json(
				Array.from({ length: 100 }, (_, offset) => ({
					id: (index - 1) * 100 + offset,
					tag_name: `v${index}.${offset}`,
					ignored: "x".repeat(30_000),
				})),
				{
					headers:
						index < 7
							? {
									link: `<https://api.github.com/repos/nocoo/app/releases?per_page=100&page=${index + 1}>; rel="next"`,
								}
							: {},
				},
			);
		});
		const result = await collectSitePage(db, lease, step, client, "fake", NOW);
		expect(result.done).toBe(index === 7);
		expect(client.count).toBe(1);
		expect(await saveRun(db, lease, result.writes, NOW, true)).toBe(true);
	}
	expect(requests).toBe(7);
	const snapshot = await readSnapshot(createDb(raw), "account", step.resource ?? "", "site");
	expect(snapshot?.releases).toHaveLength(700);
	expect(snapshot?.truncated).toBe(false);
	expect(JSON.stringify(snapshot).length).toBeLessThan(100_000);
});

it.each([false, true])(
	"resumes missing public catalog identity after listing and propagates lease stop %s",
	async (lostLease) => {
		const { raw, db, lease, step } = await setup("repos");
		lease.run.mode = "catalog";
		for (const [id, repo, visibility] of [
			["R_1", "nocoo/app", "PRIVATE"],
			["R_OLD", "nocoo/old", "PUBLIC"],
		]) {
			await db
				.prepare(
					"INSERT INTO catalog_repositories(account_id,identity_key,github_id,repo,row_payload,first_seen_at,last_seen_at,is_archived,visibility,is_fork,first_seen_source) VALUES('account',?,?,?,?,?,?,0,?,0,'github_catalog')",
				)
				.bind(
					id,
					id,
					repo,
					JSON.stringify({ name_with_owner: repo, visibility }),
					NOW,
					NOW,
					visibility,
				)
				.run();
		}
		const first = await collectSitePage(
			db,
			lease,
			step,
			github(() =>
				Response.json({
					data: {
						viewer: {
							repositories: { nodes: [rawRepo], pageInfo: { hasNextPage: false, endCursor: null } },
						},
					},
				}),
			),
			"fake",
			NOW,
		);
		expect(first.done).toBe(false);
		expect(await saveRun(db, lease, first.writes, NOW, true)).toBe(true);
		const stopped = new InvocationStopped(lostLease);
		await expect(
			collectSitePage(
				createDb(raw),
				lease,
				step,
				github(() => {
					throw stopped;
				}),
				"fake",
				NOW,
			),
		).rejects.toBe(stopped);
		const client = github((_url, init) => {
			expect(JSON.parse(String(init?.body)).variables).toEqual({ id: "R_OLD" });
			return Response.json({ data: { node: { id: "R_OLD", nameWithOwner: "nocoo/renamed" } } });
		});
		const resumedDb = createDb(raw);
		const result = await collectSitePage(resumedDb, lease, step, client, "fake", NOW);
		expect(result.done).toBe(true);
		expect(client.count).toBe(1);
		expect(await saveRun(resumedDb, lease, result.writes, NOW, true)).toBe(true);
		const plan = await createDb(raw)
			.prepare("SELECT payload FROM factory_resources WHERE stream='catalog-plan'")
			.first<{ payload: string }>();
		expect(JSON.parse(plan?.payload ?? "{}").renames).toEqual([
			{ from: "nocoo/old", to: "nocoo/renamed" },
		]);
	},
);
