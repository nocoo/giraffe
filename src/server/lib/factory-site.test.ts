import { expect, it } from "vitest";
import { github, NOW } from "../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import { createDb } from "./db/d1";
import { claimRun, saveRun, startRun } from "./db/factory-runs";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { collectSitePage, siteCatalog } from "./factory-site";

async function setup(resource: string, names = ["nocoo/app"]) {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('account','nocoo','encrypted','fake',?,?)",
		)
		.bind(NOW, NOW)
		.run();
	const run = makeRun("site", "account", "nocoo", "request", "refresh", [], NOW, [], names);
	run.cursor = run.steps.findIndex((s) => s.resource === resource);
	await startRun(db, run);
	return raw;
}

async function page(raw: D1Database, handler: Parameters<typeof github>[0]) {
	const db = createDb(raw);
	const lease = await claimRun(db, "site", NOW);
	const step = lease?.run.steps[lease.run.cursor];
	if (!lease || !step) throw new Error("fixture step");
	const result = await collectSitePage(db, lease, step, github(handler), "fake", NOW);
	await saveRun(db, lease, result.writes, NOW);
	return { ...result, cursor: step.snapshotCursor };
}

it("persists global lists in bounded chunks and publishes only after every repository was read", async () => {
	const names = Array.from({ length: 21 }, (_, i) => `org/repo${i}`);
	for (const resource of ["issues", "prs", "alerts"]) {
		const raw = await setup(resource, names);
		const key = resource === "issues" ? "issues" : resource === "prs" ? "pull_requests" : "items";
		const old = { truncated: false, fetched_at: "2025-01-01", [key]: [{ title: "previous data" }] };
		const db = createDb(raw);
		await db.batch(replaceSnapshotStmts(db, "account", resource, old, "2025-01-01"));
		const calls: string[] = [];
		const upstream: Parameters<typeof github>[0] = (url, init) => {
			if (!url.endsWith("/graphql")) return Response.json([]);
			const body = JSON.parse(String(init?.body));
			if (resource === "alerts") {
				calls.push(`${body.variables.o}/${body.variables.n}`);
				return Response.json({
					data: {
						repository: {
							vulnerabilityAlerts: {
								nodes: [
									{
										id: body.variables.n,
										securityAdvisory: { summary: "Fix dependency" },
										securityVulnerability: { severity: "HIGH" },
									},
								],
								pageInfo: { hasNextPage: false },
							},
						},
					},
				});
			}
			const group = String(body.variables.q)
				.split(" ")
				.filter((part) => part.startsWith("repo:"))
				.map((part) => part.slice(5));
			calls.push(...group);
			return Response.json({
				data: {
					search: {
						issueCount: group.length,
						pageInfo: { hasNextPage: false },
						nodes: group.map((name) => ({
							__typename: resource === "prs" ? "PullRequest" : "Issue",
							number: 1,
							title: name,
							repository: { nameWithOwner: name },
						})),
					},
				},
			});
		};
		expect(await page(raw, upstream)).toMatchObject({ done: false, cursor: 10 });
		expect(await readSnapshot(createDb(raw), "account", resource)).toEqual(old);
		expect(await page(raw, upstream)).toMatchObject({ done: false, cursor: 20 });
		expect(await readSnapshot(createDb(raw), "account", resource)).toEqual(old);
		expect(await page(raw, upstream)).toMatchObject({ done: true, cursor: 21 });
		const snapshot = await readSnapshot(createDb(raw), "account", resource);
		expect(snapshot?.[key]).toHaveLength(21);
		expect(snapshot?.truncated).toBe(false);
		if (resource === "alerts") expect(snapshot?.dependabot_open).toBe(21);
		expect(new Set(calls).size).toBe(21);
		expect(calls).toHaveLength(21);
		expect(await readSnapshot(createDb(raw), "other-account", resource)).toBeNull();
	}
});

it("treats an empty, fully known catalog as empty lists without GitHub requests", async () => {
	for (const resource of ["issues", "prs", "alerts"]) {
		const raw = await setup(resource, []);
		await page(raw, () => {
			throw new Error("No upstream calls for empty catalog");
		});
		expect(await readSnapshot(createDb(raw), "account", resource)).toMatchObject({
			truncated: false,
			unavailable: false,
		});
	}
});

it("does not publish over-budget aggregate data, or a newly discovered repository outside the frozen plan", async () => {
	const raw = await setup(
		"issues",
		Array.from({ length: 11 }, (_, i) => `org/repo${i}`),
	);
	const upstream = () =>
		Response.json({
			data: {
				search: {
					issueCount: 1,
					nodes: [
						{
							__typename: "Issue",
							number: 1,
							title: "x".repeat(800_000),
							repository: { nameWithOwner: "org/repo0" },
						},
					],
					pageInfo: { hasNextPage: false },
				},
			},
		});
	await page(raw, upstream);
	await expect(page(raw, upstream)).rejects.toMatchObject({ code: "snapshot_incomplete" });
	expect(await readSnapshot(createDb(raw), "account", "issues")).toBeNull();
	const changed = await setup("repos");
	await expect(
		page(changed, () =>
			Response.json({
				data: {
					viewer: {
						repositories: {
							nodes: [{ nameWithOwner: "org/new" }],
							pageInfo: { hasNextPage: false },
						},
					},
				},
			}),
		),
	).rejects.toMatchObject({ code: "catalog_changed" });
	expect(await siteCatalog(createDb(changed), "account")).toBeNull();
	const huge = await setup("repos");
	await expect(
		page(huge, () =>
			Response.json({
				data: {
					viewer: {
						repositories: {
							nodes: Array.from({ length: 501 }, (_, i) => ({ nameWithOwner: `org/repo${i}` })),
							pageInfo: { hasNextPage: false },
						},
					},
				},
			}),
		),
	).rejects.toMatchObject({ code: "factory_capacity" });
});

it("rejects malformed site catalogs and accepts an empty completed catalog", async () => {
	const raw = await setup("repos");
	for (const payload of [
		{ truncated: true, repos: [] },
		{ truncated: false },
		{ truncated: false, repos: [null] },
		{ truncated: false, repos: [{}] },
		{ truncated: false, repos: [{ name_with_owner: "o/.." }] },
		{ truncated: false, repos: [{ name_with_owner: "o/repo" }, { name_with_owner: "o/repo" }] },
	]) {
		const db = createDb(raw);
		await db.batch(replaceSnapshotStmts(db, "account", "repos", payload, NOW));
		expect(await siteCatalog(createDb(raw), "account")).toBeNull();
	}
	const db = createDb(raw);
	await db.batch(
		replaceSnapshotStmts(db, "account", "repos", { truncated: false, repos: [] }, NOW),
	);
	expect(await siteCatalog(createDb(raw), "account")).toEqual([]);
});
