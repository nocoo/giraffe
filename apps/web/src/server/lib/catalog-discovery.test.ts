import { expect, it, vi } from "vitest";
import { github, rawRepo } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import type { FactorySnapshot } from "../../lib/factory-types";
import type { Env } from "../env";
import { createApp } from "../index";
import { collectRepos } from "./collect";
import { savedContentMeta } from "./content-version";
import { createDb } from "./db/d1";
import { claimRun, getRun, publishedFactory, startRun } from "./db/factory-runs";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { newFactory } from "./factory-collect";
import { executeRunPage } from "./factory-execute";
import { mapFactoryRepo } from "./factory-map";
import { currentRepo, restoreLegacyRepo } from "./factory-publish";
import { pruneFactory } from "./factory-retention";
import { mapRepos } from "./github-map";
import {
	readFactoryResource,
	readMachineAccountObservation,
	readMachineFactoryStream,
	readObservation,
} from "./machine-observations";
import { readSources } from "./machine-sources";
import { prepareRefresh } from "./refresh";
import { encryptToken, parseKeyBytes } from "./token-crypto";

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

it.each([
	{ kind: "chain", reverse: false },
	{ kind: "chain", reverse: true },
	{ kind: "swap", reverse: false },
	{ kind: "swap", reverse: true },
])(
	"R7 actual discovery applies $kind renames independent of listing order (reverse=$reverse)",
	async ({ kind, reverse }) => {
		const original = [repository(1), repository(2)];
		const listing = [...original];
		const context = await fixture(original, listing);
		await context.refresh();
		await context.raw
			.prepare(
				"UPDATE repo_stars SET source='agent',starred=0,reason='second identity' WHERE repo=?",
			)
			.bind(original[1]?.nameWithOwner)
			.run();
		await context.raw
			.prepare("UPDATE repo_statistics SET enabled=1 WHERE repo=?")
			.bind(original[1]?.nameWithOwner)
			.run();
		const renamed = original.map((repo, index) => ({
			...repo,
			nameWithOwner:
				index === 0 ? "nocoo/repo-02" : kind === "swap" ? "nocoo/repo-01" : "nocoo/third",
		}));
		listing.splice(0, listing.length, ...(reverse ? [...renamed].reverse() : renamed));
		await context.refresh("2026-10-23T20:00:00.000Z");
		for (const [index, repo] of renamed.entries()) {
			expect(
				await context.raw
					.prepare("SELECT * FROM repo_stars WHERE repo=?")
					.bind(repo.nameWithOwner)
					.first(),
			).toMatchObject({
				source: index === 0 ? "owner" : "agent",
				starred: index === 0 ? 1 : 0,
				reason: index === 0 ? "manual choice" : "second identity",
				updated_at: previousAt,
			});
			expect(
				await context.raw
					.prepare("SELECT enabled FROM repo_statistics WHERE repo=?")
					.bind(repo.nameWithOwner)
					.first(),
			).toEqual({ enabled: index });
			expect(await currentRepo(createDb(context.raw), account, repo.nameWithOwner)).toMatchObject({
				id: repo.id,
				name: repo.nameWithOwner,
				observation: { repo: original[index]?.nameWithOwner, version: "original-observation" },
			});
			expect(
				await context.raw
					.prepare(
						"SELECT repo,first_seen_at,removed_at FROM catalog_repositories WHERE github_id=?",
					)
					.bind(repo.id)
					.first(),
			).toEqual({ repo: repo.nameWithOwner, first_seen_at: previousAt, removed_at: null });
		}
		expect(
			(
				await context.raw
					.prepare("SELECT kind,github_id,details FROM catalog_changes ORDER BY github_id")
					.all()
			).results,
		).toEqual(
			original.map((repo) => ({
				kind: "renamed",
				github_id: repo.id,
				details: JSON.stringify({ previous_repo: repo.nameWithOwner }),
			})),
		);
		expect(
			await context.raw.prepare("SELECT * FROM factory_repo_versions ORDER BY repo,version").all(),
		).toEqual(context.immutable);
	},
);

async function renamedRunSource() {
	const original = repository(1);
	const renamed = { ...original, nameWithOwner: "nocoo/renamed" };
	const context = await fixture([original], [renamed]);
	const repo = mapFactoryRepo(original);
	repo.coverage.commits = { ...repo.coverage.commits, status: "complete", fetchedAt: previousAt };
	repo.observation = {
		version: "original-observation",
		source: "run",
		window: newFactory(account, "nocoo", previousAt).window,
		refreshedAt: previousAt,
	};
	await context.raw
		.prepare("UPDATE factory_repo_versions SET payload=?")
		.bind(JSON.stringify(repo))
		.run();
	await context.raw
		.prepare("UPDATE factory_repo_state SET payload=json_set(payload,'$.observation',json(?))")
		.bind(JSON.stringify(repo.observation))
		.run();
	await context.raw
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('original-observation',?,'original','completed','{}',?,?,?)",
		)
		.bind(account, previousAt, previousAt, previousAt)
		.run();
	const resource = {
		runId: "original-observation",
		items: [],
		next: null,
		ranges: [repo.observation.window],
		coverage: repo.coverage.commits,
	};
	await context.raw
		.prepare(
			"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES('original-observation',?,'commits',?)",
		)
		.bind(original.nameWithOwner, JSON.stringify(resource))
		.run();
	await context.refresh();
	return { ...context, original, renamed, repo, resource };
}

it("R7 production run observation without optional repo retains its physical source before mutable rename", async () => {
	const context = await renamedRunSource();
	expect(
		await currentRepo(createDb(context.raw), account, context.renamed.nameWithOwner),
	).toMatchObject({
		id: context.original.id,
		name: context.renamed.nameWithOwner,
		observation: {
			source: "run",
			version: "original-observation",
			repo: context.original.nameWithOwner,
		},
	});
	const state = await context.raw
		.prepare("SELECT payload FROM factory_repo_state")
		.first<{ payload: string }>();
	expect(JSON.parse(state?.payload ?? "{}")).toMatchObject({
		repo: context.renamed.nameWithOwner,
		observation: { repo: context.original.nameWithOwner },
	});
});

it("R7 real quick executor reuses renamed run evidence whose original observation omitted repo", async () => {
	const context = await renamedRunSource();
	const now = "2026-10-23T20:00:00.000Z";
	await context.raw
		.prepare("UPDATE accounts SET token_ciphertext=?")
		.bind(await encryptToken("fake", parseKeyBytes("0".repeat(64))))
		.run();
	const repo = mapFactoryRepo(context.renamed);
	const run = makeRun(
		"renamed-quick",
		account,
		"nocoo",
		"renamed-quick",
		"refresh",
		[repo],
		now,
		[],
		[],
		{ scope: "selected" },
		"quick",
	);
	run.cursor = run.steps.findIndex((step) => step.kind === "commits");
	for (const step of run.steps.slice(0, run.cursor)) step.status = "success";
	run.checkpoint = newFactory(account, "nocoo", now);
	run.checkpoint.inventory.complete = true;
	run.checkpoint.contributionStatus = "unavailable";
	run.checkpoint.repos = [repo];
	await startRun(createDb(context.raw), run);
	const upstream = vi.fn(() => {
		throw new Error("matching head must reuse the physical baseline");
	});
	vi.stubGlobal("fetch", upstream);
	try {
		await executeRunPage(
			{
				DB: context.raw,
				ENVIRONMENT: "development",
				GITHUB_API_BASE: "http://fixture",
				TOKEN_ENCRYPTION_KEY_V1: "0".repeat(64),
			} as unknown as Env,
			run.id,
			() => now,
		);
	} finally {
		vi.unstubAllGlobals();
	}
	const saved = await getRun(createDb(context.raw), account, run.id);
	expect(saved?.run.steps.find((step) => step.kind === "commits")?.error).toBeNull();
	expect(saved?.run.steps.find((step) => step.kind === "commits")).toMatchObject({
		status: "success",
	});
	expect(saved?.run.checkpoint?.repos[0]?.coverage.commits).toMatchObject({
		status: "complete",
		strategy: "reused",
		sourceFetchedAt: previousAt,
	});
	expect(upstream).not.toHaveBeenCalled();
});

it("R7 renamed production run state remains a GC root after old publication refs and recent-run roots retire", async () => {
	const context = await renamedRunSource();
	const db = createDb(context.raw);
	const factory = newFactory(account, "nocoo", previousAt);
	factory.repos = [context.repo];
	await db.batch(
		await replaceSnapshotStmts(db, account, "factory:v:original-observation", factory, previousAt),
	);
	await context.raw
		.prepare(
			"INSERT INTO factory_version_refs VALUES(?,'original-observation',?,'original-observation','run')",
		)
		.bind(account, context.original.nameWithOwner)
		.run();
	for (let index = 0; index < 22; index++) {
		const at = `2027-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`;
		await context.raw
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,?,?,'completed','{}',?,?,?)",
			)
			.bind(`newer-${index}`, account, `newer-${index}`, at, at, at)
			.run();
		if (index >= 20) {
			const writeDb = createDb(context.raw);
			await writeDb.batch(
				await replaceSnapshotStmts(
					writeDb,
					account,
					`factory:v:newer-${index}`,
					newFactory(account, "nocoo", at),
					at,
				),
			);
		}
	}
	await context.raw
		.prepare("INSERT INTO factory_state(account_id,published_id,next_at) VALUES(?,'newer-21',?)")
		.bind(account, currentAt)
		.run();
	await pruneFactory(createDb(context.raw), "2027-02-01T00:00:00.000Z");
	expect(
		await context.raw
			.prepare("SELECT * FROM factory_version_refs WHERE publication_id='original-observation'")
			.all(),
	).toMatchObject({ results: [] });
	expect(
		await context.raw
			.prepare("SELECT * FROM snapshots WHERE kind='factory:v:original-observation'")
			.all(),
	).toMatchObject({ results: [] });
	expect(
		await currentRepo(createDb(context.raw), account, context.renamed.nameWithOwner),
	).toMatchObject({
		id: context.original.id,
		observation: { source: "run", repo: context.original.nameWithOwner },
	});
	expect(
		await context.raw
			.prepare(
				"SELECT payload FROM factory_resources WHERE run_id='original-observation' AND stream='commits'",
			)
			.first(),
	).toEqual({ payload: JSON.stringify(context.resource) });
});

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

async function returnedCatalogEvidence(source: "run" | "legacy", sameId = false) {
	const original = repository(1);
	const listing: Repository[] = [];
	const context = await fixture([original], listing);
	const db = createDb(context.raw);
	const factory = (await readSnapshot(db, account, "factory")) as FactorySnapshot;
	const observed = factory.repos[0];
	if (!observed?.observation) throw new Error("Missing original observation");
	observed.observation.source = source;
	observed.coverage.commits = {
		...observed.coverage.commits,
		status: "complete",
		fetchedAt: previousAt,
	};
	await db.batch(await replaceSnapshotStmts(db, account, "factory", factory, previousAt));
	const resource = {
		runId: "original-observation",
		items: [],
		next: null,
		ranges: [],
		coverage: observed.coverage.commits,
	};
	if (source === "run") {
		await context.raw
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('original-observation',?,'original','completed','{}',?,?,?)",
			)
			.bind(account, previousAt, previousAt, previousAt)
			.run();
		await context.raw
			.prepare(
				"INSERT INTO factory_resources(run_id,repo,stream,payload,content_meta) VALUES('original-observation',?,'commits',?,?)",
			)
			.bind(
				original.nameWithOwner,
				JSON.stringify(resource),
				await savedContentMeta(`factory:${original.nameWithOwner}:commits`, resource),
			)
			.run();
	} else {
		await db.batch(
			await replaceSnapshotStmts(
				db,
				account,
				`factory:${original.nameWithOwner}:commits`,
				resource,
				previousAt,
			),
		);
	}
	const frozen = await context.raw
		.prepare("SELECT * FROM snapshots WHERE kind LIKE 'factory%' ORDER BY kind")
		.all();
	await context.refresh();
	const replacement = { ...original, id: sameId ? original.id : "R_REPLACEMENT" };
	listing.push(replacement);
	await context.refresh("2026-10-23T20:00:00.000Z");
	return { ...context, original, replacement, frozen };
}

it.each(["run", "legacy"] as const)(
	"R7 different-ID same-name replacement rejects old %s immutable stream without rewriting history",
	async (source) => {
		const context = await returnedCatalogEvidence(source);
		await expect(
			readMachineFactoryStream(
				createDb(context.raw),
				account,
				context.replacement.nameWithOwner,
				"commits",
			),
		).rejects.toMatchObject({ status: 404, code: "not_found" });
		await expect(
			readFactoryResource(
				createDb(context.raw),
				account,
				context.replacement.nameWithOwner,
				"commits",
			),
		).rejects.toMatchObject({ status: 404, code: "not_found" });
		const browser = await createApp().request(
			`http://localhost/api/factory/repos/${context.replacement.nameWithOwner}/commits`,
			{},
			{ DB: context.raw, ENVIRONMENT: "development", GITHUB_API_BASE: "http://fixture" } as Env,
		);
		expect(browser.status).toBe(404);
		expect(
			await context.raw
				.prepare("SELECT * FROM snapshots WHERE kind LIKE 'factory%' ORDER BY kind")
				.all(),
		).toEqual(context.frozen);
	},
);

it.each(["run", "legacy"] as const)(
	"R7 current factory projection leaves replacement missing instead of accepting old %s identity by name",
	async (source) => {
		const context = await returnedCatalogEvidence(source);
		const observation = await readObservation(createDb(context.raw), account, "factory", "all");
		expect(observation.data).toMatchObject({
			repos: [],
			freshness: { total: 1, missing: 1 },
			truncated: true,
		});
	},
);

it.each(["run", "legacy"] as const)(
	"R7 sources excludes replaced %s identity and exposes missing current factory coverage",
	async (source) => {
		const context = await returnedCatalogEvidence(source);
		const result = await readSources(createDb(context.raw), account, {
			repository: context.replacement.nameWithOwner,
		});
		expect(result.repositories).toEqual([context.replacement.nameWithOwner]);
		expect(result.sources.filter((item) => item.resource.startsWith("factory:"))).toEqual([]);
		expect(result.sources.find((item) => item.resource === "account:factory")).toMatchObject({
			freshness: { total: 1, missing: 1 },
			truncated: true,
		});
	},
);

it.each(["run", "legacy"] as const)(
	"R7 same-ID reappearance retains %s evidence and original provenance without restoring stars",
	async (source) => {
		const context = await returnedCatalogEvidence(source, true);
		const observation = await readMachineFactoryStream(
			createDb(context.raw),
			account,
			context.replacement.nameWithOwner,
			"commits",
		);
		expect(observation).toMatchObject({
			sourceVersion: "original-observation",
			fetchedAt: previousAt,
			data: { coverage: { status: "complete" }, observation: { source, refreshedAt: previousAt } },
		});
		expect(observation.contentVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect((await readSources(createDb(context.raw), account, {})).sources).toContainEqual(
			expect.objectContaining({
				resource: `factory:${context.replacement.nameWithOwner}:commits`,
				fetchedAt: previousAt,
				version: "original-observation",
			}),
		);
		expect(
			(await readObservation(createDb(context.raw), account, "factory", "all")).data.repos,
		).toHaveLength(1);
		expect(await context.raw.prepare("SELECT * FROM repo_stars").all()).toMatchObject({
			results: [],
		});
		expect(
			await context.raw
				.prepare("SELECT * FROM snapshots WHERE kind LIKE 'factory%' ORDER BY kind")
				.all(),
		).toEqual(context.frozen);
	},
);

it.each(["all", "starred"] as const)(
	"R7 %s removed inclusion never applies a replacement owner star to the departed identity",
	async (scope) => {
		const context = await returnedCatalogEvidence("run");
		await context.raw
			.prepare(
				"INSERT INTO repo_stars(account_id,repo,starred,source,updated_at,reason) VALUES(?,?,1,'owner',?,'new identity choice')",
			)
			.bind(account, context.replacement.nameWithOwner, "2026-10-23T20:00:00.000Z")
			.run();
		const observation = await readMachineAccountObservation(
			createDb(context.raw),
			account,
			"repos",
			scope,
			true,
		);
		const rows = observation.data.repos as Record<string, unknown>[];
		expect(rows).toHaveLength(scope === "all" ? 2 : 1);
		expect(rows.find((row) => row.removed_at === null)).toMatchObject({
			starred: true,
			star_source: "owner",
			statistics_enabled: true,
		});
		if (scope === "all")
			expect(rows.find((row) => row.removed_at !== null)).toMatchObject({
				removed_at: currentAt,
				starred: false,
				star_source: null,
				star_updated_at: null,
				statistics_enabled: false,
			});
		const response = await createApp().request(
			`http://localhost/api/repos?scope=${scope}&include=removed`,
			{},
			{ DB: context.raw, ENVIRONMENT: "development", GITHUB_API_BASE: "http://fixture" } as Env,
		);
		expect(response.status).toBe(200);
		expect(((await response.json()) as { repos: unknown[] }).repos).toEqual(rows);
	},
);

it.each([false, true])(
	"R7 catalog restore never rebinds retired legacy evidence to another identity (sameId=%s)",
	async (sameId) => {
		const context = await returnedCatalogEvidence("legacy", sameId);
		const db = createDb(context.raw);
		const factory = (await readSnapshot(db, account, "factory")) as FactorySnapshot;
		const observed = factory.repos[0];
		if (!observed?.observation) throw new Error("Missing original observation");
		observed.observation.version = previousAt;
		await db.batch(await replaceSnapshotStmts(db, account, "factory", factory, previousAt));
		await db.batch(
			await replaceSnapshotStmts(
				db,
				account,
				`factory:${context.original.nameWithOwner}:commits`,
				{
					runId: previousAt,
					items: [],
					next: null,
					ranges: [],
					coverage: observed.coverage.commits,
				},
				previousAt,
			),
		);
		const now = "2026-10-24T20:00:00.000Z";
		const run = makeRun("catalog-restore", account, "nocoo", "catalog-restore", "catalog", [], now);
		await startRun(db, run);
		const lease = await claimRun(db, run.id, now);
		if (!lease) throw new Error("Missing catalog lease");
		const writes = await restoreLegacyRepo(db, lease, now, mapFactoryRepo(context.replacement));
		expect(writes).toHaveLength(sameId ? 2 : 0);
		await db.batch(writes);
		const restored = await currentRepo(db, account, context.replacement.nameWithOwner);
		if (sameId)
			expect(restored).toMatchObject({
				id: context.original.id,
				observation: { source: "legacy", version: previousAt, refreshedAt: previousAt },
			});
		else expect(restored).toBeNull();
	},
);

it.each([
	{ sameId: false, removeRoot: false, archivedProof: false, recovers: false },
	{ sameId: true, removeRoot: false, archivedProof: false, recovers: true },
	{ sameId: true, removeRoot: true, archivedProof: false, recovers: false },
	{ sameId: true, removeRoot: true, archivedProof: true, recovers: true },
])(
	"R7 discovery removes the old member from the real publication before same-name restore (sameId=$sameId, removeRoot=$removeRoot, archivedProof=$archivedProof)",
	async ({ sameId, removeRoot, archivedProof, recovers }) => {
		const original = repository(1);
		const listing: Repository[] = [];
		const context = await fixture([original], listing);
		const db = createDb(context.raw);
		const factory = (await readSnapshot(db, account, "factory")) as FactorySnapshot;
		const observed = factory.repos[0];
		if (!observed?.observation) throw new Error("Missing legacy source identity");
		observed.observation.version = previousAt;
		observed.coverage.commits = {
			...observed.coverage.commits,
			status: "complete",
			fetchedAt: previousAt,
		};
		await db.batch(await replaceSnapshotStmts(db, account, "factory", factory, previousAt));
		await db.batch(
			await replaceSnapshotStmts(
				db,
				account,
				`factory:${original.nameWithOwner}:commits`,
				{
					runId: previousAt,
					items: [],
					next: null,
					ranges: [],
					coverage: observed.coverage.commits,
				},
				previousAt,
			),
		);
		await context.refresh();
		await context.raw
			.prepare("UPDATE accounts SET capabilities=?,token_ciphertext=?")
			.bind(
				JSON.stringify({ repo: true }),
				await encryptToken("fake", parseKeyBytes("0".repeat(64))),
			)
			.run();
		const headAt = "2026-10-23T20:00:00.000Z";
		const departure = makeRun(
			"departed-head",
			account,
			"nocoo",
			"departed-head",
			"catalog",
			[],
			headAt,
		);
		await startRun(createDb(context.raw), departure);
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (new URL(String(input)).pathname !== "/graphql")
				throw new Error("Unexpected catalog request");
			return Response.json({
				data: {
					viewer: {
						login: "nocoo",
						repositories: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false } },
					},
				},
			});
		});
		try {
			for (let page = 0; page < 10; page++) {
				if ((await getRun(createDb(context.raw), account, departure.id))?.run.status !== "running")
					break;
				await executeRunPage(
					{
						DB: context.raw,
						ENVIRONMENT: "development",
						GITHUB_API_BASE: "http://fixture",
						TOKEN_ENCRYPTION_KEY_V1: "0".repeat(64),
					} as unknown as Env,
					departure.id,
					() => headAt,
				);
			}
		} finally {
			vi.unstubAllGlobals();
		}
		expect((await getRun(createDb(context.raw), account, departure.id))?.run.status).toBe(
			"completed",
		);
		expect(await publishedFactory(createDb(context.raw), account)).toMatchObject({
			runId: departure.id,
			repos: [],
		});
		const replacement = { ...original, id: sameId ? original.id : "R_REPLACEMENT" };
		listing.push(replacement);
		await context.refresh("2026-10-24T20:00:00.000Z");
		if (removeRoot)
			await context.raw
				.prepare("DELETE FROM snapshots WHERE kind IN ('factory','factory#2')")
				.run();
		if (archivedProof)
			await context.raw
				.prepare(
					"INSERT INTO factory_repo_versions(account_id,repo,version,payload,refreshed_at) VALUES(?,?,?,?,?)",
				)
				.bind(account, original.nameWithOwner, previousAt, JSON.stringify(observed), previousAt)
				.run();
		const frozen = await context.raw
			.prepare("SELECT * FROM snapshots WHERE kind LIKE 'factory%' ORDER BY kind")
			.all();
		const immutable = await context.raw
			.prepare("SELECT * FROM factory_repo_versions ORDER BY repo,version")
			.all();
		const now = "2026-10-25T20:00:00.000Z";
		const restore = makeRun(
			"positive-restore",
			account,
			"nocoo",
			"positive-restore",
			"catalog",
			[],
			now,
		);
		const restoreDb = createDb(context.raw);
		await startRun(restoreDb, restore);
		const lease = await claimRun(restoreDb, restore.id, now);
		if (!lease) throw new Error("Missing restore lease");
		const writes = await restoreLegacyRepo(restoreDb, lease, now, mapFactoryRepo(replacement));
		expect(writes).toHaveLength(recovers ? 2 : 0);
		await restoreDb.batch(writes);
		const current = await currentRepo(restoreDb, account, replacement.nameWithOwner);
		if (recovers)
			expect(current).toMatchObject({
				id: original.id,
				coverage: { commits: { status: "complete" } },
				observation: {
					source: "legacy",
					repo: original.nameWithOwner,
					version: previousAt,
					window: observed.observation.window,
					refreshedAt: previousAt,
				},
			});
		else expect(current).toBeNull();
		expect(
			await context.raw
				.prepare("SELECT * FROM snapshots WHERE kind LIKE 'factory%' ORDER BY kind")
				.all(),
		).toEqual(frozen);
		const after = (
			await context.raw.prepare("SELECT * FROM factory_repo_versions ORDER BY repo,version").all()
		).results;
		for (const row of immutable.results) expect(after).toContainEqual(row);
	},
);
