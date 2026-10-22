import { expect, it } from "vitest";
import { github, NOW } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import { createDb } from "./db/d1";
import { claimRun, saveRun, startRun } from "./db/factory-runs";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { newFactory } from "./factory-collect";
import { publicationWrites } from "./factory-publish";
import { collectSitePage, siteCatalog } from "./factory-site";
import { mapActionRuns } from "./github-map";
import { splitPages } from "./snapshot-pages";

it("retains complete Actions when publication metadata overflows two exact 1500000-byte pages", async () => {
	const resource = "repo:nocoo/app:actions";
	const raw = await setup(resource);
	const db = createDb(raw);
	await db.batch(
		await replaceSnapshotStmts(
			db,
			"account",
			resource,
			{ runs: [{ id: 7 }], truncated: false },
			"2026-01-01T00:00:00.000Z",
		),
	);
	const before = await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all();
	await db.batch(
		await replaceSnapshotStmts(db, "account", "factory", newFactory("account", "nocoo", NOW), NOW),
	);
	const runs = Array.from({ length: 2000 }, (_, index) => ({
		id: index + 1,
		name: "x".repeat(1300),
	}));
	for (const start of [0, 1000]) {
		const group = runs.slice(start, start + 1000);
		const encoded = JSON.stringify({
			truncated: false,
			runs: mapActionRuns({ workflow_runs: group }),
			fetched_at: NOW,
		});
		const padding = 1_500_000 - new TextEncoder().encode(encoded).length;
		for (const item of group) item.name += "x".repeat(Math.floor(padding / 1000));
		const last = group.at(-1);
		if (!last) throw new Error("fixture group missing");
		last.name += "x".repeat(padding % 1000);
	}
	const preview = splitPages(resource, {
		truncated: false,
		runs: mapActionRuns({ workflow_runs: runs }),
		fetched_at: NOW,
	});
	expect(preview.truncated).toBe(false);
	expect(preview.pages.map((page) => new TextEncoder().encode(page.payload).length)).toEqual([
		1_500_000, 1_500_000,
	]);
	const lease = await claimRun(db, "site", NOW);
	const step = lease?.run.steps[lease.run.cursor];
	if (!lease || !step) throw new Error("fixture lease missing");
	let cursor = 0;
	await expect(
		collectSitePage(
			db,
			lease,
			step,
			github(() => {
				const items = runs.slice(cursor, cursor + 100);
				cursor += 100;
				return Response.json(
					{ workflow_runs: items },
					{
						headers:
							cursor < runs.length
								? {
										link: `<https://api.github.com/repos/nocoo/app/actions/runs?per_page=100&page=${cursor / 100 + 1}>; rel="next"`,
									}
								: {},
					},
				);
			}),
			"fake",
			NOW,
		),
	).rejects.toMatchObject({ code: "snapshot_incomplete" });
	expect(cursor).toBe(2000);
	expect(
		await raw
			.prepare("SELECT count(*) AS total FROM factory_resources WHERE stream LIKE 'site:%'")
			.first(),
	).toEqual({ total: 0 });
	step.status = "failed";
	step.error = "snapshot_incomplete";
	lease.run.status = "partial";
	const writes = await publicationWrites(db, lease, NOW);
	lease.run.publishedAt = NOW;
	expect(await saveRun(db, lease, writes, NOW)).toBe(true);
	expect(
		await raw.prepare("SELECT * FROM snapshots WHERE kind LIKE 'repo:%' ORDER BY kind").all(),
	).toEqual(before);
});

it("retains the exact prior snapshot when retained evidence would truncate current security", async () => {
	const raw = await setup("repo:nocoo/app:security");
	const db = createDb(raw);
	await db.batch(
		await replaceSnapshotStmts(
			db,
			"account",
			"repo:nocoo/app:security",
			{
				truncated: false,
				unavailable: false,
				dependabot_open: 0,
				code_scanning_open: 100,
				items: Array.from({ length: 100 }, (_, index) => ({
					source: "code_scanning",
					id: index,
					title: "x".repeat(12_000),
				})),
			},
			"2026-01-01T00:00:00.000Z",
		),
	);
	const before = await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all();
	await expect(
		page(raw, (url) =>
			url.endsWith("/graphql")
				? Response.json({
						data: {
							repository: {
								vulnerabilityAlerts: {
									nodes: Array.from({ length: 20 }, (_, index) => ({
										id: String(index),
										securityAdvisory: { summary: "y".repeat(60_000) },
									})),
									pageInfo: { hasNextPage: false },
								},
							},
						},
					})
				: Response.json({ message: "Not Found" }, { status: 404 }),
		),
	).rejects.toMatchObject({ code: "snapshot_incomplete" });
	expect(await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(before);
});

it("persists unavailable repository security instead of failing the snapshot, without erasing good global data", async () => {
	const raw = await setup("repo:nocoo/app:security");
	const db = createDb(raw);
	const prior = {
		truncated: false,
		items: [{ name_with_owner: "nocoo/app", source: "dependabot" }],
		dependabot_open: 1,
		code_scanning_open: 0,
	};
	await db.batch(await replaceSnapshotStmts(db, "account", "alerts", prior, "2026-01-01"));
	const result = await page(raw, (url) =>
		url.endsWith("/graphql")
			? Response.json({
					data: { repository: null },
					errors: [
						{
							type: "FORBIDDEN",
							message: "Dependabot alerts are disabled for this repository.",
							path: ["repository"],
						},
					],
				})
			: Response.json(
					{ message: "Dependabot alerts are disabled for this repository." },
					{ status: 403 },
				),
	);
	expect(result).toMatchObject({ done: true, unavailable: true, reasonCode: "alerts_disabled" });
	expect(await readSnapshot(db, "account", "repo:nocoo/app:security", "site")).toMatchObject({
		unavailable: true,
		truncated: false,
		reason_code: "alerts_disabled",
	});
	expect(await readSnapshot(db, "account", "alerts")).toMatchObject({
		...prior,
		fetched_at: "2026-01-01",
	});
});

it("keeps prior security evidence separately without relabeling unavailable feature counts", async () => {
	const raw = await setup("repo:nocoo/app:security");
	const db = createDb(raw);
	await db.batch(
		await replaceSnapshotStmts(
			db,
			"account",
			"repo:nocoo/app:security",
			{
				truncated: false,
				unavailable: false,
				dependabot_open: 7,
				code_scanning_open: 2,
				items: [{ source: "dependabot", name_with_owner: "nocoo/app" }],
			},
			"2026-01-01",
		),
	);
	for (let index = 0; index < 2; index++) {
		await page(raw, (url) =>
			url.endsWith("/graphql")
				? Response.json({
						data: { repository: null },
						errors: [
							{
								type: "FORBIDDEN",
								message: "Resource not accessible by integration",
								path: ["repository"],
							},
						],
					})
				: Response.json({ message: "Resource not accessible by integration" }, { status: 403 }),
		);
		expect(await readSnapshot(db, "account", "repo:nocoo/app:security", "site")).toMatchObject({
			unavailable: true,
			dependabot_open: null,
			code_scanning_open: null,
			fetched_at: NOW,
			items: [],
			retained: {
				dependabot: { open: 7, fetched_at: "2026-01-01" },
				code_scanning: { open: 2, fetched_at: "2026-01-01" },
			},
		});
	}
});

it("counts a mixed security snapshot as unavailable work without hiding its available feature", async () => {
	const raw = await setup("repo:nocoo/app:security");
	const result = await page(raw, (url) =>
		url.endsWith("/graphql")
			? Response.json({
					data: {
						repository: {
							vulnerabilityAlerts: { nodes: [{ id: "1" }], pageInfo: { hasNextPage: false } },
						},
					},
				})
			: Response.json({ message: "Not Found" }, { status: 404 }),
	);
	expect(result).toMatchObject({ done: true, unavailable: true, reasonCode: "not_found" });
	expect(
		await readSnapshot(createDb(raw), "account", "repo:nocoo/app:security", "site"),
	).toMatchObject({
		unavailable: false,
		dependabot_open: 1,
		code_scanning_open: null,
		features: {
			dependabot: { status: "available" },
			code_scanning: { status: "unavailable", reason_code: "not_found" },
		},
	});
});

it("never replaces global alerts with an unavailable page and never publishes truncated security", async () => {
	const raw = await setup("alerts");
	const db = createDb(raw);
	const prior = {
		truncated: false,
		items: [{ source: "dependabot", name_with_owner: "nocoo/app" }],
		dependabot_open: 1,
		code_scanning_open: 0,
	};
	await db.batch(await replaceSnapshotStmts(db, "account", "alerts", prior, "2026-01-01"));
	expect(
		await page(raw, () =>
			Response.json(
				{ message: "Dependabot alerts are disabled for this repository." },
				{ status: 403 },
			),
		),
	).toMatchObject({ unavailable: true, reasonCode: "alerts_disabled" });
	expect(await readSnapshot(db, "account", "alerts")).toMatchObject({
		...prior,
		fetched_at: "2026-01-01",
	});
	const security = await setup("repo:nocoo/app:security");
	await expect(
		page(security, (url) =>
			url.endsWith("/graphql")
				? Response.json({
						data: {
							repository: {
								vulnerabilityAlerts: {
									nodes: [],
									pageInfo: { hasNextPage: true, endCursor: "same" },
								},
							},
						},
					})
				: Response.json([]),
		),
	).rejects.toMatchObject({ code: "snapshot_incomplete" });
	expect(await readSnapshot(createDb(security), "account", "repo:nocoo/app:security")).toBeNull();
});

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
		await db.batch(await replaceSnapshotStmts(db, "account", resource, old, "2025-01-01"));
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
		expect(await readSnapshot(createDb(raw), "account", resource)).toEqual(old);
		const snapshot = await readSnapshot(createDb(raw), "account", resource, "site");
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
		expect(await readSnapshot(createDb(raw), "account", resource, "site")).toMatchObject({
			truncated: false,
			unavailable: false,
		});
	}
});

it("does not publish over-budget aggregate data, or a newly discovered repository outside the frozen plan", async () => {
	const raw = await setup(
		"issues",
		Array.from({ length: 11 }, (_, i) => `nocoo/repo${i}`),
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
							nodes: [{ nameWithOwner: "nocoo/new" }],
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
							nodes: Array.from({ length: 501 }, (_, i) => ({ nameWithOwner: `nocoo/repo${i}` })),
							pageInfo: { hasNextPage: false },
						},
					},
				},
			}),
		),
	).rejects.toMatchObject({ code: "catalog_capacity" });
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
		await db.batch(await replaceSnapshotStmts(db, "account", "repos", payload, NOW));
		expect(await siteCatalog(createDb(raw), "account")).toBeNull();
	}
	const db = createDb(raw);
	await db.batch(
		await replaceSnapshotStmts(db, "account", "repos", { truncated: false, repos: [] }, NOW),
	);
	expect(await siteCatalog(createDb(raw), "account")).toEqual([]);
});

it("reuses current-run global pages for repository details without another GitHub request", async () => {
	const raw = await setup("repo:nocoo/app:issues");
	const db = createDb(raw);
	const lease = await claimRun(db, "site", NOW);
	if (!lease) throw new Error("fixture");
	const source = lease.run.steps.find((s) => s.resource === "issues");
	if (!source) throw new Error("fixture");
	source.status = "success";
	await db.batch(
		await replaceSnapshotStmts(
			db,
			"account",
			"issues",
			{
				truncated: false,
				issues: [
					{ name_with_owner: "nocoo/app", number: 1 },
					{ name_with_owner: "other/app", number: 2 },
				],
			},
			NOW,
		),
	);
	const step = lease.run.steps[lease.run.cursor];
	if (!step) throw new Error("fixture");
	const result = await collectSitePage(
		db,
		lease,
		step,
		github(() => {
			throw new Error("duplicate request");
		}),
		"fake",
		NOW,
	);
	await saveRun(db, lease, result.writes, NOW);
	expect(
		(await readSnapshot(createDb(raw), "account", "repo:nocoo/app:issues", "site"))?.issues,
	).toEqual([{ name_with_owner: "nocoo/app", number: 1 }]);
});
it("merges selected repository updates into the global list while preserving unrelated data and its full-scan time", async () => {
	const raw = await setup("repo:nocoo/app:issues");
	const db = createDb(raw);
	await db.batch(
		await replaceSnapshotStmts(
			db,
			"account",
			"issues",
			{
				truncated: false,
				issues: [
					{ name_with_owner: "nocoo/app", number: 1 },
					{ name_with_owner: "other/app", number: 2 },
				],
			},
			"2026-09-01T00:00:00.000Z",
		),
	);
	const lease = await claimRun(db, "site", NOW);
	if (!lease) throw new Error("fixture");
	lease.run.selection = { scope: "selected", repos: ["nocoo/app"] };
	const step = lease.run.steps[lease.run.cursor];
	if (!step) throw new Error("fixture");
	const result = await collectSitePage(
		db,
		lease,
		step,
		github(() =>
			Response.json({
				data: { search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } } },
			}),
		),
		"fake",
		NOW,
	);
	await saveRun(db, lease, result.writes, NOW);
	const saved = await readSnapshot(createDb(raw), "account", "issues", "site");
	expect(saved?.issues).toEqual([{ name_with_owner: "other/app", number: 2 }]);
	expect(saved?.fetched_at).toBe("2026-09-01T00:00:00.000Z");
	expect(saved?.repository_fetched_at).toEqual({ "nocoo/app": NOW });
});

it("reuses code-dependent page data only when its recorded head matches the current metadata", async () => {
	for (const sourceHead of ["old", "current", undefined]) {
		const raw = await setup("repo:nocoo/app:languages");
		const db = createDb(raw);
		await db.batch(
			await replaceSnapshotStmts(
				db,
				"account",
				"repo:nocoo/app:languages",
				{
					truncated: false,
					languages: { Old: 1 },
					...(sourceHead ? { source_head: sourceHead } : {}),
				},
				"2026-09-01T00:00:00.000Z",
			),
		);
		const lease = await claimRun(db, "site", NOW);
		if (!lease) throw new Error("fixture");
		lease.run.depth = "quick";
		const step = lease.run.steps[lease.run.cursor];
		if (!step) throw new Error("fixture");
		lease.run.steps.push({ ...step, kind: "metadata", status: "success", sourceHead: "current" });
		const gh = github(() => Response.json({ New: 2 }));
		const result = await collectSitePage(db, lease, step, gh, "fake", NOW);
		await saveRun(db, lease, result.writes, NOW);
		const saved = await readSnapshot(createDb(raw), "account", "repo:nocoo/app:languages", "site");
		expect(saved?.languages).toEqual(sourceHead === "current" ? { Old: 1 } : { New: 2 });
		expect(saved?.source_head).toBe("current");
		expect(gh.count).toBe(sourceHead === "current" ? 0 : 1);
	}
});

it("bootstraps partial global lists without inventing coverage for unselected repositories", async () => {
	const raw = await setup("repo:nocoo/app:issues");
	const db = createDb(raw);
	const lease = await claimRun(db, "site", NOW);
	if (!lease) throw new Error("fixture");
	lease.run.selection = { scope: "selected", repos: ["nocoo/app"] };
	const step = lease.run.steps[lease.run.cursor];
	if (!step) throw new Error("fixture");
	const result = await collectSitePage(
		db,
		lease,
		step,
		github(() =>
			Response.json({
				data: { search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } } },
			}),
		),
		"fake",
		NOW,
	);
	await saveRun(db, lease, result.writes, NOW);
	expect(await readSnapshot(createDb(raw), "account", "issues", "site")).toMatchObject({
		issues: [],
		truncated: true,
		repository_fetched_at: { "nocoo/app": NOW },
	});
});

it("derives scoped Insights only after selected sources succeed and preserves unrelated rows", async () => {
	for (const existing of [false, true]) {
		const raw = await setup("insights");
		const db = createDb(raw);
		await db.batch(await replaceSnapshotStmts(db, "account", "issues", { issues: [] }, NOW));
		await db.batch(
			await replaceSnapshotStmts(
				db,
				"account",
				"repos",
				{ repos: [{ name_with_owner: "nocoo/app", open_issue_count: 2, pushed_at: NOW }] },
				NOW,
			),
		);
		if (existing) {
			await db.batch(
				await replaceSnapshotStmts(
					db,
					"account",
					"insights",
					{ insights: [{ name_with_owner: "other/repo" }], truncated: false },
					"2026-09-01",
				),
			);
			await db.batch(
				await replaceSnapshotStmts(db, "account", "alerts", { items: [], truncated: false }, NOW),
			);
		}
		const lease = await claimRun(db, "site", NOW);
		if (!lease) throw new Error("fixture");
		lease.run.selection = { scope: "selected", repos: ["nocoo/app"] };
		const step = lease.run.steps[lease.run.cursor];
		if (!step) throw new Error("fixture");
		const gh = github(() => {
			throw new Error("must not fetch");
		});
		await expect(collectSitePage(db, lease, step, gh, "fake", NOW)).rejects.toMatchObject({
			code: "snapshot_sources_incomplete",
		});
		for (const source of lease.run.steps)
			if (["repo:nocoo/app:details", "repo:nocoo/app:issues"].includes(source.resource ?? ""))
				source.status = "success";
		const result = await collectSitePage(db, lease, step, gh, "fake", NOW);
		await saveRun(db, lease, result.writes, NOW);
		const saved = await readSnapshot(createDb(raw), "account", "insights", "site");
		expect(saved).toMatchObject({
			repository_fetched_at: { "nocoo/app": NOW },
			truncated: !existing,
		});
		expect(saved?.insights).toHaveLength(existing ? 2 : 1);
		expect(
			((saved?.insights ?? []) as { name_with_owner: string; open_issue_count: number }[]).find(
				(row) => row.name_with_owner === "nocoo/app",
			)?.open_issue_count,
		).toBe(0);
	}
});

it("rejects oversized scoped Insights without replacing its previous publication", async () => {
	const raw = await setup("insights");
	const db = createDb(raw);
	await db.batch(await replaceSnapshotStmts(db, "account", "issues", { issues: [] }, NOW));
	await db.batch(
		await replaceSnapshotStmts(
			db,
			"account",
			"repos",
			{ repos: [{ name_with_owner: "nocoo/app", pushed_at: NOW }] },
			NOW,
		),
	);
	await db.batch(
		await replaceSnapshotStmts(
			db,
			"account",
			"alerts",
			{
				items: Array.from({ length: 2 }, () => ({
					name_with_owner: "nocoo/app",
					source: "dependabot",
					severity: "high",
					summary: "x".repeat(800_000),
				})),
			},
			NOW,
		),
	);
	const lease = await claimRun(db, "site", NOW);
	if (!lease) throw new Error("fixture");
	lease.run.selection = { scope: "selected", repos: ["nocoo/app"] };
	for (const source of lease.run.steps)
		if (["repo:nocoo/app:details", "repo:nocoo/app:issues"].includes(source.resource ?? ""))
			source.status = "success";
	const step = lease.run.steps[lease.run.cursor];
	if (!step) throw new Error("fixture");
	await expect(
		collectSitePage(
			db,
			lease,
			step,
			github(() => {
				throw new Error("no network");
			}),
			"fake",
			NOW,
		),
	).rejects.toMatchObject({ code: "snapshot_incomplete" });
	expect(await readSnapshot(createDb(raw), "account", "insights")).toBeNull();
});

it("retains Insights when selected metadata cannot be joined to a complete saved catalogue", async () => {
	for (const catalog of [
		null,
		{ repos: [], truncated: false },
		{ repos: [{ name_with_owner: "nocoo/app" }], truncated: true },
	]) {
		const raw = await setup("insights");
		const db = createDb(raw);
		if (catalog) await db.batch(await replaceSnapshotStmts(db, "account", "repos", catalog, NOW));
		const lease = await claimRun(db, "site", NOW);
		if (!lease) throw new Error("fixture");
		lease.run.selection = { scope: "selected", repos: ["nocoo/app"] };
		for (const source of lease.run.steps)
			if (["repo:nocoo/app:details", "repo:nocoo/app:issues"].includes(source.resource ?? ""))
				source.status = "success";
		const step = lease.run.steps[lease.run.cursor];
		if (!step) throw new Error("fixture");
		await expect(
			collectSitePage(
				db,
				lease,
				step,
				github(() => {
					throw new Error("no network");
				}),
				"fake",
				NOW,
			),
		).rejects.toMatchObject({ code: "snapshot_sources_incomplete" });
		expect(await readSnapshot(createDb(raw), "account", "insights")).toBeNull();
	}
});
