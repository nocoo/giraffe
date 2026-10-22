import { afterEach, expect, it, vi } from "vitest";
import { github, rawRepo } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import type { Env } from "../env";
import { beginCatalog, planCatalog } from "./catalog-history";
import { createDb } from "./db/d1";
import { claimRun, getRun, saveRun, startRun } from "./db/factory-runs";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { newFactory } from "./factory-collect";
import { executeRunPage } from "./factory-execute";
import { mapFactoryRepo } from "./factory-map";
import { publicationWrites } from "./factory-publish";
import { mapRepos } from "./github-map";
import { encryptToken, parseKeyBytes } from "./token-crypto";

afterEach(() => vi.unstubAllGlobals());

it("R7 real catalog executor stages discovery then atomically publishes history even with an existing head", async () => {
	const now = "2026-10-22T20:00:00.000Z";
	const previous = "2026-10-21T20:00:00.000Z";
	const account = "catalog-executor";
	const raw = sqliteFixture();
	const env = {
		DB: raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
		TOKEN_ENCRYPTION_KEY_V1: "0".repeat(64),
	} as unknown as Env;
	const db = createDb(raw);
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,capabilities,created_at,updated_at) VALUES(?,'nocoo',?,'fake',?,?,?)",
		)
		.bind(
			account,
			await encryptToken("fake", parseKeyBytes("0".repeat(64))),
			JSON.stringify({ repo: true }),
			previous,
			previous,
		)
		.run();
	const original = { ...rawRepo, isArchived: false, isFork: false };
	const discovered = {
		...original,
		id: "R_NEW",
		nameWithOwner: "nocoo/new",
		url: "https://github.com/nocoo/new",
		isArchived: true,
	};
	const factory = newFactory(account, "nocoo", previous);
	factory.inventory.complete = true;
	factory.repos = [mapFactoryRepo(original)];
	await db.batch(await replaceSnapshotStmts(db, account, "factory:v:old", factory, previous));
	await db.batch(
		await replaceSnapshotStmts(db, account, "repos", { repos: mapRepos([original]) }, previous),
	);
	await raw
		.prepare("INSERT INTO factory_state(account_id,published_id,next_at) VALUES(?,'old',?)")
		.bind(account, previous)
		.run();
	await raw
		.prepare(
			"INSERT INTO repo_stars(account_id,repo,source,updated_at) VALUES(?,'nocoo/app','owner',?)",
		)
		.bind(account, previous)
		.run();
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const pathname = new URL(String(input)).pathname;
		if (pathname === "/graphql") {
			const body = String(init?.body);
			if (!body.includes("repositories(")) throw new Error("Unexpected catalog query");
			return Response.json({
				data: {
					viewer: {
						login: "nocoo",
						repositories: { nodes: [discovered], totalCount: 1, pageInfo: { hasNextPage: false } },
					},
				},
			});
		}
		if (pathname === "/repos/nocoo/app")
			return Response.json({ message: "Not Found" }, { status: 404 });
		throw new Error(`Unexpected catalog request ${pathname}`);
	});
	await expect(
		startRun(db, makeRun("new-catalog", account, "nocoo", "catalog-request", "catalog", [], now)),
	).resolves.toMatchObject({ status: "running" });
	let milliseconds = Date.parse(now);
	for (let page = 0; page < 20; page++) {
		const saved = await getRun(createDb(raw), account, "new-catalog");
		if (saved?.run.status !== "running") break;
		const next = saved.run.steps[saved.run.cursor];
		if (next?.kind === "publish") {
			expect((await readSnapshot(createDb(raw), account, "repos"))?.repos).toEqual(
				mapRepos([original]),
			);
			expect(await raw.prepare("SELECT count(*) AS count FROM catalog_changes").first()).toEqual({
				count: 0,
			});
		}
		await expect(
			executeRunPage(env, "new-catalog", () => new Date(milliseconds).toISOString()),
		).resolves.not.toBeUndefined();
		milliseconds += 1000;
	}
	expect((await getRun(createDb(raw), account, "new-catalog"))?.run.status).toBe("completed");
	expect((await readSnapshot(createDb(raw), account, "repos"))?.repos).toMatchObject([
		{ name_with_owner: "nocoo/new", is_archived: true },
		{ name_with_owner: "nocoo/app", removed_at: null },
	]);
	expect(
		await raw
			.prepare("SELECT kind,repo,source_kind,source_run_id FROM catalog_changes ORDER BY kind")
			.all(),
	).toMatchObject({
		results: [
			{ kind: "added", repo: "nocoo/new", source_kind: "factory", source_run_id: "new-catalog" },
		],
	});
	expect(
		await raw.prepare("SELECT * FROM repo_stars WHERE account_id=?").bind(account).all(),
	).toMatchObject({ results: [{ repo: "nocoo/app" }] });
	expect(
		(await readSnapshot(createDb(raw), account, "factory:catalog:new-catalog"))?.repos,
	).toMatchObject([{ name: "nocoo/new" }, { name: "nocoo/app" }]);
	expect((await readSnapshot(createDb(raw), account, "factory:v:old"))?.repos).toEqual(
		factory.repos,
	);
});

it("R7 revoked publication lease atomically preserves membership, stars, history and publication heads", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	const now = "2026-10-22T20:00:00.000Z";
	const account = "revoked-catalog";
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake',?,?)",
		)
		.bind(account, now, now)
		.run();
	await db.batch(
		await replaceSnapshotStmts(db, account, "repos", { repos: mapRepos([rawRepo]) }, now),
	);
	await raw
		.prepare(
			"INSERT INTO repo_stars(account_id,repo,source,updated_at) VALUES(?,'nocoo/app','owner',?)",
		)
		.bind(account, now)
		.run();
	const previousFactory = newFactory(account, "nocoo", now);
	previousFactory.repos = [mapFactoryRepo(rawRepo)];
	await db.batch(await replaceSnapshotStmts(db, account, "factory", previousFactory, now));
	await startRun(db, makeRun("revoked-run", account, "nocoo", "revoked-key", "catalog", [], now));
	const lease = await claimRun(db, "revoked-run", now);
	if (!lease) throw new Error("Missing publication lease");
	const next = { ...rawRepo, id: "R_NEW", nameWithOwner: "nocoo/new" };
	const checkpoint = newFactory(account, "nocoo", now);
	checkpoint.inventory.complete = true;
	checkpoint.repos = [mapFactoryRepo(next), mapFactoryRepo(rawRepo)];
	lease.run.checkpoint = checkpoint;
	for (const step of lease.run.steps) if (step.kind !== "publish") step.status = "success";
	const plan = await planCatalog(
		await beginCatalog(db, account),
		{ truncated: false, repos: mapRepos([next]) },
		{ "nocoo/new": "R_NEW" },
		"nocoo",
		github(() => Response.json({ message: "Not Found" }, { status: 404 })),
		"fixture",
		now,
		{ kind: "factory", runId: lease.run.id },
	);
	await raw
		.prepare(
			"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,'','catalog-plan',?)",
		)
		.bind(lease.run.id, JSON.stringify(plan))
		.run();
	const saved = await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all();
	const head = await raw.prepare("SELECT * FROM factory_state").all();
	const writes = await publicationWrites(db, lease, now);
	await raw
		.prepare("UPDATE factory_runs SET lease_token='revoked' WHERE id=?")
		.bind(lease.run.id)
		.run();
	expect(await saveRun(db, lease, writes, now)).toBe(false);
	expect(await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(saved);
	expect(await raw.prepare("SELECT * FROM factory_state").all()).toEqual(head);
	expect(await raw.prepare("SELECT * FROM catalog_changes").all()).toMatchObject({ results: [] });
	expect(await raw.prepare("SELECT * FROM catalog_repositories").all()).toMatchObject({
		results: [],
	});
	expect(await raw.prepare("SELECT repo FROM repo_stars").all()).toMatchObject({
		results: [{ repo: "nocoo/app" }],
	});
});
