import { expect, it } from "vitest";
import { github, rawRepo } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { FactorySnapshot } from "../../lib/factory-types";
import type { Env } from "../env";
import { createApp } from "../index";
import { collectRepos } from "./collect";
import { createDb } from "./db/d1";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { newFactory } from "./factory-collect";
import { mapFactoryRepo } from "./factory-map";
import { currentRepo } from "./factory-publish";
import { pruneFactory } from "./factory-retention";
import { mapRepos } from "./github-map";
import { readMachineFactoryStream } from "./machine-observations";
import { readSources } from "./machine-sources";
import { prepareRefresh } from "./refresh";

const previousAt = "2026-10-21T20:00:00.000Z";
const currentAt = "2026-10-22T20:00:00.000Z";
const account = "catalog-account";

function repository(index: number, options: { archived?: boolean; fork?: boolean } = {}) {
	const name = `repo-${index.toString().padStart(2, "0")}`;
	return {
		...rawRepo,
		id: `R_${index}`,
		name,
		nameWithOwner: `nocoo/${name}`,
		url: `https://github.com/nocoo/${name}`,
		visibility: "PUBLIC",
		isPrivate: false,
		isArchived: options.archived ?? false,
		isFork: options.fork ?? false,
		stargazerCount: index,
		forkCount: index + 1,
	};
}

type Repository = ReturnType<typeof repository>;

async function fixture(
	before: Repository[],
	after: Repository[],
	options: { lookupStatus?: number; truncated?: boolean; nullNode?: boolean } = {},
) {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?,'nocoo','fake','fake',1,?,?)",
		)
		.bind(account, previousAt, previousAt)
		.run();
	await db.batch(
		await replaceSnapshotStmts(
			db,
			account,
			"repos",
			{ repos: mapRepos(before), truncated: false },
			previousAt,
		),
	);
	const factory = newFactory(account, "nocoo", previousAt);
	factory.inventory = {
		total: before.length,
		scanned: before.length,
		complete: true,
		after: null,
		pages: 1,
		excluded: [],
	};
	factory.repos = before.map((node) => ({
		...mapFactoryRepo(node),
		observation: {
			version: "original-observation",
			window: factory.window,
			refreshedAt: previousAt,
			source: "legacy" as const,
			repo: node.nameWithOwner,
		},
	}));
	await db.batch(await replaceSnapshotStmts(db, account, "factory", factory, previousAt));
	for (const repo of factory.repos) {
		await raw
			.prepare(
				"INSERT INTO repo_stars(account_id,repo,starred,source,updated_at,reason) VALUES(?,?,1,'owner',?,'manual choice')",
			)
			.bind(account, repo.name, previousAt)
			.run();
		await raw
			.prepare("INSERT INTO repo_statistics(account_id,repo,enabled) VALUES(?,?,0)")
			.bind(account, repo.name)
			.run();
		await raw
			.prepare(
				"INSERT INTO factory_repo_versions(account_id,repo,version,payload,refreshed_at) VALUES(?,?,'original-observation',?,?)",
			)
			.bind(account, repo.name, JSON.stringify(repo), previousAt)
			.run();
		await raw
			.prepare(
				"INSERT INTO factory_repo_state(account_id,repo,version,payload) VALUES(?,?,'original-observation',?)",
			)
			.bind(
				account,
				repo.name,
				JSON.stringify({
					repo: repo.name,
					status: "success",
					refreshedAt: previousAt,
					nextAllowedAt: previousAt,
					observation: repo.observation,
				}),
			)
			.run();
	}
	const requests: string[] = [];
	const queries: string[] = [];
	const gh = github((url, init) => {
		const pathname = new URL(url).pathname;
		requests.push(pathname);
		if (pathname === "/graphql") {
			const body = JSON.parse(String(init?.body)) as { query: string };
			queries.push(body.query);
			return Response.json({
				data: {
					viewer: {
						login: "nocoo",
						repositories: {
							totalCount: after.length,
							nodes: options.nullNode ? [...after, null] : after,
							pageInfo: {
								hasNextPage: options.truncated ?? false,
								endCursor: null,
							},
						},
					},
				},
			});
		}
		const name = pathname.replace(/^\/repos\//, "");
		const found = after.find((repo) => repo.nameWithOwner === name);
		if (found)
			return Response.json({
				node_id: found.id,
				full_name: found.nameWithOwner,
				archived: found.isArchived,
				fork: found.isFork,
				visibility: found.visibility.toLowerCase(),
			});
		const status = options.lookupStatus ?? 404;
		return Response.json(
			{ message: status === 404 ? "Not Found" : "Fixture upstream unavailable" },
			{ status },
		);
	});
	const original = await readSnapshot(db, account, "repos");
	const immutable = await raw
		.prepare("SELECT * FROM factory_repo_versions ORDER BY repo,version")
		.all();
	async function refresh(fetchedAt = currentAt) {
		const requestDb = createDb(raw);
		const prepared = await prepareRefresh(
			requestDb,
			account,
			gh,
			"fixture-token",
			["repos"],
			fetchedAt,
			{},
			{ deriveInsights: false },
		);
		await requestDb.batch(prepared.stmts);
		return readSnapshot(requestDb, account, "repos");
	}
	return { raw, db, gh, requests, queries, original, immutable, refresh };
}

function names(snapshot: Record<string, unknown> | null) {
	if (!Array.isArray(snapshot?.repos)) throw new Error("missing fixture catalog");
	return (snapshot.repos as { name_with_owner: string }[]).map((repo) => repo.name_with_owner);
}

it("R7 requests stable catalog identity without changing existing mapped repository fields", async () => {
	const context = await fixture([], [repository(1)]);
	const collected = await collectRepos(context.gh, "fixture-token");
	expect(collected.repos).toEqual(mapRepos([repository(1)]));
	expect(context.queries[0]).toMatch(/nodes\s*\{\s*id\b/);
});

it.each([403, 429, 500])(
	"R7 preserves unconfirmed missing membership and stars after direct lookup %s",
	async (lookupStatus) => {
		const before = [repository(1), repository(2)];
		const context = await fixture(before, [before[0] as Repository, repository(3)], {
			lookupStatus,
		});
		const saved = await context.refresh();
		expect(names(saved).sort()).toEqual(
			before.map((repo) => repo.nameWithOwner).concat("nocoo/repo-03"),
		);
		expect(
			await context.raw.prepare("SELECT repo FROM repo_stars ORDER BY repo").all(),
		).toMatchObject({
			results: [{ repo: "nocoo/repo-01" }, { repo: "nocoo/repo-02" }],
		});
		expect(context.requests).toContain("/repos/nocoo/repo-02");
	},
);

it.each([
	{ source: "owner", starred: 1 },
	{ source: "owner", starred: 0 },
	{ source: "agent", starred: 1 },
] as const)(
	"R7 confirmed removal deletes $source star state $starred without touching history",
	async ({ source, starred }) => {
		const context = await fixture([repository(1)], []);
		await context.db
			.prepare("UPDATE repo_stars SET source=?,starred=? WHERE account_id=?")
			.bind(source, starred, account)
			.run();
		const saved = await context.refresh();
		expect(names(saved)).toEqual([]);
		for (const table of ["repo_stars", "repo_statistics", "factory_repo_state"])
			expect(
				await context.raw.prepare(`SELECT * FROM ${table} WHERE account_id=?`).bind(account).all(),
			).toMatchObject({ results: [] });
		expect(
			await context.raw.prepare("SELECT * FROM factory_repo_versions ORDER BY repo,version").all(),
		).toEqual(context.immutable);
		expect(context.requests).toContain("/repos/nocoo/repo-01");
	},
);

it("R7 mass-removal guard keeps missing members and still admits newly discovered repositories", async () => {
	const before = Array.from({ length: 31 }, (_, index) => repository(index));
	const context = await fixture(before, [...before.slice(4), repository(99)]);
	const saved = await context.refresh();
	expect(names(saved).sort()).toEqual(
		[...before.map((repo) => repo.nameWithOwner), "nocoo/repo-99"].sort(),
	);
	expect(context.requests).toEqual(["/graphql"]);
	expect(await context.raw.prepare("SELECT count(*) AS count FROM repo_stars").first()).toEqual({
		count: 31,
	});
});

it("R7 guard denominator includes every owned archived and fork member at the exact ten-percent boundary", async () => {
	const before = Array.from({ length: 40 }, (_, index) =>
		repository(index, { archived: index < 20, fork: index >= 20 && index < 35 }),
	);
	const context = await fixture(before, before.slice(4));
	await context.refresh();
	expect(context.requests.filter((request) => request.startsWith("/repos/"))).toHaveLength(4);
	expect(await context.raw.prepare("SELECT count(*) AS count FROM repo_stars").first()).toEqual({
		count: 36,
	});
});

it("R7 non-owned and departed history never inflate the owned mass guard or refresh missing last-seen evidence", async () => {
	const owned = Array.from({ length: 31 }, (_, index) => repository(index));
	const external = Array.from({ length: 100 }, (_, index) => ({
		...repository(index + 100),
		nameWithOwner: `external/repo-${index}`,
	}));
	const context = await fixture(
		[...owned, ...external],
		[...owned.slice(4), ...external, repository(999)],
	);
	for (let index = 0; index < 100; index++)
		await context.raw
			.prepare(
				"INSERT INTO catalog_repositories(account_id,identity_key,github_id,repo,row_payload,first_seen_at,last_seen_at,removed_at,is_archived,visibility,is_fork,first_seen_source) VALUES(?,?,?,?,?,?,?,?,0,'PUBLIC',0,'saved_catalog')",
			)
			.bind(
				account,
				`removed-${index}`,
				`R_REMOVED_${index}`,
				`nocoo/departed-${index}`,
				JSON.stringify({ name_with_owner: `nocoo/departed-${index}` }),
				previousAt,
				previousAt,
				previousAt,
			)
			.run();
	const saved = await context.refresh();
	expect(names(saved)).toHaveLength(132);
	expect(context.requests).toEqual(["/graphql"]);
	expect(
		await context.raw
			.prepare("SELECT warning_code FROM catalog_state WHERE account_id=?")
			.bind(account)
			.first(),
	).toEqual({ warning_code: "catalog_mass_removal_guard" });
	expect(
		await context.raw
			.prepare(
				"SELECT last_seen_at,removed_at FROM catalog_repositories WHERE repo='nocoo/repo-00'",
			)
			.first(),
	).toEqual({ last_seen_at: previousAt, removed_at: null });
	expect(
		await context.raw.prepare("SELECT * FROM catalog_changes WHERE kind='removed'").all(),
	).toMatchObject({ results: [] });
});

it("R7 incomplete catalog pagination preserves the previous catalog and its observation time", async () => {
	const context = await fixture([repository(1), repository(2)], [repository(1)], {
		truncated: true,
	});
	await context.refresh();
	expect(await readSnapshot(context.db, account, "repos")).toEqual(context.original);
	expect(context.requests).toEqual(["/graphql"]);
});

it("R7 nullable catalog node is incomplete evidence and cannot authorize deletion or last-seen advancement", async () => {
	const context = await fixture([repository(1)], [], { nullNode: true });
	await context.refresh();
	expect(await readSnapshot(createDb(context.raw), account, "repos")).toEqual(context.original);
	expect(context.requests).toEqual(["/graphql"]);
	expect(await context.raw.prepare("SELECT * FROM catalog_changes").all()).toMatchObject({
		results: [],
	});
});

it("R7 stable-id rename moves mutable owner choice while preserving original observation references", async () => {
	const original = repository(1);
	const renamed = {
		...original,
		name: "renamed",
		nameWithOwner: "nocoo/renamed",
		url: "https://github.com/nocoo/renamed",
	};
	const context = await fixture([original], [renamed]);
	await context.refresh();
	expect(
		await context.raw.prepare("SELECT repo,source,starred,reason,updated_at FROM repo_stars").all(),
	).toMatchObject({
		results: [
			{
				repo: "nocoo/renamed",
				source: "owner",
				starred: 1,
				reason: "manual choice",
				updated_at: previousAt,
			},
		],
	});
	expect(
		await context.raw.prepare("SELECT repo,payload FROM factory_repo_state").all(),
	).toMatchObject({
		results: [{ repo: "nocoo/renamed", payload: expect.any(String) }],
	});
	const state = await context.raw
		.prepare("SELECT payload FROM factory_repo_state")
		.first<{ payload: string }>();
	expect(JSON.parse(state?.payload ?? "null")).toMatchObject({
		repo: "nocoo/renamed",
		observation: { repo: original.nameWithOwner, version: "original-observation" },
	});
	expect(
		await context.raw.prepare("SELECT * FROM factory_repo_versions ORDER BY repo,version").all(),
	).toEqual(context.immutable);
	expect(context.requests).toEqual(["/graphql"]);
});

it("R7 ordinary catalog rediscovery adds no supplemental GitHub requests or automatic stars", async () => {
	const context = await fixture([repository(1)], [repository(1), repository(2)]);
	await context.refresh();
	expect(context.gh.count).toBe(1);
	expect(context.requests).toEqual(["/graphql"]);
	expect(
		await context.raw.prepare("SELECT repo FROM repo_stars ORDER BY repo").all(),
	).toMatchObject({
		results: [{ repo: "nocoo/repo-01" }],
	});
});

it("R7 actual catalog collection records lifecycle changes and reappearance without restoring deleted stars", async () => {
	const initial = repository(1);
	const listing = [initial, repository(2)];
	const context = await fixture([initial], listing);
	await context.refresh();
	const secondAt = "2026-10-23T20:00:00.000Z";
	listing.splice(0, listing.length, {
		...initial,
		isArchived: true,
		isFork: true,
		visibility: "PRIVATE",
		isPrivate: true,
	});
	await context.refresh(secondAt);
	const thirdAt = "2026-10-24T20:00:00.000Z";
	listing.splice(0, listing.length, initial, repository(2));
	await context.refresh(thirdAt);
	const changes = await context.raw
		.prepare("SELECT kind,repo,at,source_kind,details FROM catalog_changes ORDER BY at,kind,repo")
		.all();
	expect(changes.results).toEqual([
		{ kind: "added", repo: "nocoo/repo-02", at: currentAt, source_kind: "legacy", details: "{}" },
		{
			kind: "archived",
			repo: "nocoo/repo-01",
			at: secondAt,
			source_kind: "legacy",
			details: JSON.stringify({ before: false, after: true }),
		},
		{
			kind: "fork_changed",
			repo: "nocoo/repo-01",
			at: secondAt,
			source_kind: "legacy",
			details: JSON.stringify({ before: false, after: true }),
		},
		{ kind: "removed", repo: "nocoo/repo-02", at: secondAt, source_kind: "legacy", details: "{}" },
		{
			kind: "visibility_changed",
			repo: "nocoo/repo-01",
			at: secondAt,
			source_kind: "legacy",
			details: JSON.stringify({ before: "PUBLIC", after: "PRIVATE" }),
		},
		{ kind: "added", repo: "nocoo/repo-02", at: thirdAt, source_kind: "legacy", details: "{}" },
		{
			kind: "fork_changed",
			repo: "nocoo/repo-01",
			at: thirdAt,
			source_kind: "legacy",
			details: JSON.stringify({ before: true, after: false }),
		},
		{
			kind: "unarchived",
			repo: "nocoo/repo-01",
			at: thirdAt,
			source_kind: "legacy",
			details: JSON.stringify({ before: true, after: false }),
		},
		{
			kind: "visibility_changed",
			repo: "nocoo/repo-01",
			at: thirdAt,
			source_kind: "legacy",
			details: JSON.stringify({ before: "PRIVATE", after: "PUBLIC" }),
		},
	]);
	expect(
		await context.raw
			.prepare(
				"SELECT repo,first_seen_at,last_seen_at,archived_changed_at,removed_at FROM catalog_repositories ORDER BY repo",
			)
			.all(),
	).toMatchObject({
		results: [
			{
				repo: initial.nameWithOwner,
				first_seen_at: previousAt,
				last_seen_at: thirdAt,
				archived_changed_at: thirdAt,
				removed_at: null,
			},
			{
				repo: "nocoo/repo-02",
				first_seen_at: currentAt,
				last_seen_at: thirdAt,
				archived_changed_at: null,
				removed_at: null,
			},
		],
	});
	expect(
		await context.raw.prepare("SELECT repo FROM repo_stars ORDER BY repo").all(),
	).toMatchObject({ results: [{ repo: initial.nameWithOwner }] });
});

it.each([
	{ source: "owner", starred: 0 },
	{ source: "agent", starred: 1 },
] as const)(
	"R7 stable-id rename preserves $source choice $starred and never rewrites immutable versions",
	async ({ source, starred }) => {
		const original = repository(1);
		const renamed = { ...original, nameWithOwner: "nocoo/renamed" };
		const context = await fixture([original], [renamed]);
		await context.raw
			.prepare("UPDATE repo_stars SET source=?,starred=?")
			.bind(source, starred)
			.run();
		await context.refresh();
		expect(
			await context.raw.prepare("SELECT repo,source,starred,updated_at FROM repo_stars").all(),
		).toMatchObject({
			results: [{ repo: renamed.nameWithOwner, source, starred, updated_at: previousAt }],
		});
		expect(
			await context.raw.prepare("SELECT * FROM factory_repo_versions ORDER BY repo,version").all(),
		).toEqual(context.immutable);
	},
);

it("R7 legacy catalog revision race aborts every history, cleanup and snapshot write atomically", async () => {
	const context = await fixture([repository(1)], [repository(2)]);
	const prepared = await prepareRefresh(
		context.db,
		account,
		context.gh,
		"fixture-token",
		["repos"],
		currentAt,
		{},
		{ deriveInsights: false },
	);
	await context.raw
		.prepare(
			"INSERT INTO catalog_state(account_id,history_since,checked_at,revision) VALUES(?,?,?,9)",
		)
		.bind(account, previousAt, currentAt)
		.run();
	const saved = await context.raw.prepare("SELECT * FROM snapshots ORDER BY kind").all();
	await expect(context.db.batch(prepared.stmts)).rejects.toMatchObject({ code: "db_error" });
	expect(await context.raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(saved);
	expect(await context.raw.prepare("SELECT * FROM catalog_changes").all()).toMatchObject({
		results: [],
	});
	expect(await context.raw.prepare("SELECT repo FROM repo_stars").all()).toMatchObject({
		results: [{ repo: "nocoo/repo-01" }],
	});
	expect(await context.raw.prepare("SELECT revision FROM catalog_state").first()).toEqual({
		revision: 9,
	});
});

it.each([false, true])(
	"R7 rename resolves currentRepo and immutable stream through original observation identity before and after GC (unversioned=%s)",
	async (unversioned) => {
		const original = repository(1);
		const context = await fixture([original], [{ ...original, nameWithOwner: "nocoo/renamed" }]);
		const repo = mapFactoryRepo(original);
		const sourceVersion = unversioned ? previousAt : "original-observation";
		const resource = {
			runId: sourceVersion,
			items: [
				{
					id: "sha",
					title: "original evidence",
					url: "https://github.com/nocoo/repo-01/commit/sha",
					at: previousAt,
					createdAt: previousAt,
					closedAt: null,
					mergedAt: null,
					author: "nocoo",
					state: "committed",
				},
			],
			next: null,
			ranges: [],
			coverage: { ...repo.coverage.commits, status: "complete", fetchedAt: previousAt },
		};
		const savedDb = createDb(context.raw);
		const factory = (await readSnapshot(savedDb, account, "factory")) as FactorySnapshot | null;
		if (!factory?.repos[0]) throw new Error("Missing saved factory fixture");
		factory.repos[0].coverage.commits.status = "complete";
		if (unversioned) delete factory.repos[0].observation;
		factory.runId = sourceVersion;
		await savedDb.batch(
			await replaceSnapshotStmts(savedDb, account, "factory", { ...factory }, previousAt),
		);
		await savedDb.batch(
			await replaceSnapshotStmts(
				savedDb,
				account,
				`factory:${original.nameWithOwner}:commits`,
				resource,
				previousAt,
			),
		);
		const frozen = await context.raw
			.prepare(
				"SELECT * FROM snapshots WHERE kind='factory' OR kind LIKE 'factory:%' ORDER BY kind",
			)
			.all();
		await context.refresh();
		const read = () =>
			readMachineFactoryStream(createDb(context.raw), account, "nocoo/renamed", "commits");
		expect(await currentRepo(createDb(context.raw), account, "nocoo/renamed")).toMatchObject({
			name: "nocoo/renamed",
			observation: { repo: original.nameWithOwner, version: "original-observation" },
		});
		expect(await read()).toMatchObject({
			sourceVersion,
			data: { items: resource.items },
		});
		expect(
			(await readSources(createDb(context.raw), account, { repository: "nocoo/renamed" })).sources,
		).toContainEqual(
			expect.objectContaining({
				resource: "factory:nocoo/renamed:commits",
				version: sourceVersion,
			}),
		);
		const browser = await createApp().request(
			"http://localhost/api/factory/repos/nocoo/renamed/commits",
			{},
			{ DB: context.raw, ENVIRONMENT: "development", GITHUB_API_BASE: "http://fixture" } as Env,
		);
		expect(browser.status).toBe(200);
		await pruneFactory(createDb(context.raw), "2027-02-01T00:00:00.000Z");
		expect(
			await context.raw.prepare("SELECT * FROM factory_repo_versions ORDER BY repo,version").all(),
		).toEqual(context.immutable);
		expect(await read()).toMatchObject({
			sourceVersion,
			data: { items: resource.items },
		});
		expect(
			await context.raw
				.prepare(
					"SELECT * FROM snapshots WHERE kind='factory' OR kind LIKE 'factory:%' ORDER BY kind",
				)
				.all(),
		).toEqual(frozen);
	},
);
