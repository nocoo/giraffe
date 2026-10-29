import { expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { savedObservationStmts } from "../../../../../tests/fixtures/refresh";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { readActivity } from "./activity-store";
import { readCatalogChanges } from "./catalog-read";
import { storedContent } from "./content-version";
import { getAccount } from "./db/accounts";
import { createDb } from "./db/d1";
import { publishedFactory, resolveFactoryRunReference } from "./db/factory-runs";
import { readRepositorySnapshot, readSnapshot } from "./db/snapshots";
import { readObservation } from "./machine-observations";
import { readSources } from "./machine-sources";
import { collectAccount } from "./refresh-collection";
import { readRepoAgentState, writeRepoAgentState } from "./repo-agent-state";
import { readRepoMeta, writeRepoMeta } from "./repo-meta";
import { repoPolicy } from "./snapshot-projection";

async function fixture() {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','nocoo','fake','fake','t','t')",
		)
		.run();
	return { raw, db: createDb(raw) };
}

it("rejects all retired snapshot, publication, run and catalog sources", async () => {
	const { raw, db } = await fixture();
	for (const [kind, data] of [
		["repos", { repos: [{ name_with_owner: "nocoo/app" }] }],
		["repo:nocoo/app:issues", { issues: [] }],
		["factory", factoryFixture()],
	] as const)
		await raw
			.prepare("INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES('a',?,?,'t')")
			.bind(kind, JSON.stringify(data))
			.run();
	await raw
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('retired','a','retired','completed','{}','t','t','t')",
		)
		.run();
	expect(await readSnapshot(db, "a", "repos")).toBeNull();
	expect(await readRepositorySnapshot(db, "a", "repo:nocoo/app:issues")).toBeNull();
	expect(await publishedFactory(db, "a")).toBeNull();
	expect((await repoPolicy(db, "a")).repos).toEqual([]);
	expect(await readSources(db, "a", {})).toMatchObject({ repositories: [], sources: [] });
	await expect(resolveFactoryRunReference(db, "a", "retired")).rejects.toMatchObject({
		status: 404,
	});
});

it("reads the canonical refresh snapshot with its content metadata, not a stale publication", async () => {
	const { raw, db } = await fixture();
	const publication = factoryFixture();
	await raw
		.prepare("INSERT INTO refresh_publications(account_id,payload,published_at) VALUES('a',?,'t')")
		.bind(JSON.stringify(publication))
		.run();
	expect(await publishedFactory(db, "a")).toBeNull();
	await db.batch(
		await savedObservationStmts(db, "a", "factory", publication, publication.fetched_at),
	);
	await raw
		.prepare(
			"UPDATE refresh_publications SET payload=json_set(payload,'$.runId','stale') WHERE account_id='a'",
		)
		.run();
	const saved = await publishedFactory(db, "a");
	expect(saved).toMatchObject({ runId: publication.runId, truncated: false });
	expect(storedContent(saved)?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
	expect(storedContent(saved)).toEqual(storedContent(await readSnapshot(db, "a", "factory")));
	await db.batch(
		await savedObservationStmts(
			db,
			"a",
			"repos",
			{ repos: publication.repos.map((repo) => ({ id: repo.id, name_with_owner: repo.name })) },
			publication.fetched_at,
		),
	);
	const envelope = await readObservation(db, "a", "factory", "all");
	const indexed = (await readSources(db, "a", {})).sources.find(
		(source) => source.resource === "account:factory",
	);
	expect(envelope.contentVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
	expect(indexed).toMatchObject({
		contentVersion: envelope.contentVersion,
		version: envelope.sourceVersion,
	});
});

it("does not reinterpret daily total commits as author-specific activity", async () => {
	const { raw, db } = await fixture();
	await raw
		.prepare(
			"INSERT INTO refresh_runs(id,account_id,status,trigger,payload,created_at,updated_at) VALUES('current','a','completed','manual','{}','t','t')",
		)
		.run();
	const fetch = vi.spyOn(globalThis, "fetch");
	try {
		await expect(readActivity(db, "a", { run: ["current"] })).rejects.toMatchObject({
			status: 409,
			code: "activity_unpublished",
		});
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});

it("uses current refresh catalog identity and ignores conflicting retired history", async () => {
	const { raw, db } = await fixture();
	await raw
		.prepare(
			"INSERT INTO refresh_snapshots(account_id,kind,payload,fetched_at) VALUES('a','repos',?,'t')",
		)
		.bind(JSON.stringify({ repos: [{ id: "R_CURRENT", name_with_owner: "nocoo/renamed" }] }))
		.run();
	await raw
		.prepare(
			"INSERT INTO refresh_catalog(account_id,repo_id,repo,discovered_day,timezone,payload,fetched_at) VALUES('a','R_CURRENT','nocoo/renamed','2026-10-29','Asia/Shanghai','{}','t')",
		)
		.run();
	await raw
		.prepare(
			"INSERT INTO catalog_repositories(account_id,identity_key,github_id,repo,row_payload,is_archived,visibility,is_fork,first_seen_source) VALUES('a','R_RETIRED','R_RETIRED','nocoo/renamed','{}',0,'PUBLIC',0,'github_catalog')",
		)
		.run();
	const template = factoryFixture().repos[0];
	if (!template) throw new Error("missing fixture repository");
	const policy = await repoPolicy(db, "a");
	expect(
		policy.canonicalRepo({ ...template, id: "R_CURRENT", name: "nocoo/original" }),
	).toMatchObject({ name: "nocoo/renamed" });
	expect(policy.canonicalRepo({ ...template, id: "R_RETIRED", name: "nocoo/renamed" })).toBeNull();
	expect(policy.repos).toMatchObject([{ id: "R_CURRENT", name_with_owner: "nocoo/renamed" }]);
});

it("uses newly collected catalog-only identities for mutable metadata and agent state through rename", async () => {
	const { raw, db } = await fixture();
	const account = await getAccount(db, "a");
	if (!account) throw new Error("fixture account missing");
	const now = "2026-10-29T04:00:00.000Z";
	const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({
			data: {
				viewer: {
					login: "nocoo",
					repositories: {
						totalCount: 1,
						nodes: [{ id: "R_CURRENT", nameWithOwner: "nocoo/new", owner: { login: "nocoo" } }],
						pageInfo: { hasNextPage: false, endCursor: null },
					},
					contributionsCollection: {
						restrictedContributionsCount: 0,
						contributionCalendar: {
							totalContributions: 1,
							weeks: [{ contributionDays: [{ date: "2026-10-28", contributionCount: 1 }] }],
						},
					},
				},
				rateLimit: { remaining: 4999, resetAt: "2026-10-29T05:00:00Z" },
			},
		}),
	);
	try {
		await collectAccount({
			env: { DB: raw, ENVIRONMENT: "test", GITHUB_API_BASE: "http://refresh.fixture" } as Env,
			account,
			token: "fake-memory-only-token",
			now,
			days: [
				{
					date: "2026-10-28",
					since: "2026-10-27T16:00:00.000Z",
					until: "2026-10-28T16:00:00.000Z",
				},
			],
			run: {
				id: "current",
				accountId: "a",
				params: {
					since: "2026-10-28",
					until: "2026-10-28",
					timezone: "Asia/Shanghai",
					dimensions: ["commits"],
					force: false,
				},
				trigger: "manual",
				status: "running",
				phase: "account",
				repos: [],
				completedRepos: 0,
				requests: 0,
				partial: false,
				errorCode: null,
				createdAt: now,
				updatedAt: now,
				finishedAt: null,
			},
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	} finally {
		fetch.mockRestore();
	}
	expect((await raw.prepare("SELECT * FROM catalog_repositories").all()).results).toEqual([]);
	expect(await readRepoAgentState(db, "a", "NOCOO/NEW")).toMatchObject({
		payload: null,
		revision: null,
		repo_removed: false,
	});
	expect(await readRepoMeta(db, "a", "NOCOO/NEW")).toMatchObject({
		category: null,
		first_seen_at: null,
		deleted_at: null,
	});
	const state = await writeRepoAgentState(
		db,
		"a",
		"nocoo/new",
		{ payload: { summary: "new observation" } },
		"fixture",
	);
	await writeRepoMeta(db, "a", "nocoo/new", { category: "app" });
	await raw
		.prepare("UPDATE refresh_catalog SET repo='nocoo/renamed' WHERE repo_id='R_CURRENT'")
		.run();
	expect(await readRepoAgentState(db, "a", "nocoo/renamed")).toMatchObject({
		payload: state.payload,
		revision: state.revision,
	});
	expect(await readRepoMeta(db, "a", "nocoo/renamed")).toMatchObject({ category: "app" });
	await expect(readRepoAgentState(db, "a", "nocoo/new")).rejects.toMatchObject({ status: 404 });
	await expect(readRepoMeta(db, "a", "nocoo/new")).rejects.toMatchObject({ status: 404 });
	for (const table of ["repo_agent_state", "repo_meta"])
		expect((await raw.prepare(`SELECT identity_key FROM ${table}`).all()).results).toEqual([
			{ identity_key: "R_CURRENT" },
		]);
});

it("never lets a retired same-name catalog identity inject local state or provide a fallback target", async () => {
	const { raw, db } = await fixture();
	await raw
		.prepare(
			"INSERT INTO catalog_repositories(account_id,identity_key,github_id,repo,row_payload,is_archived,visibility,is_fork,first_seen_source) VALUES('a','R_OLD','R_OLD','nocoo/app','{}',0,'PUBLIC',0,'github_catalog')",
		)
		.run();
	await raw
		.prepare(
			"INSERT INTO repo_agent_state(account_id,identity_key,payload,revision,updated_at,updated_by) VALUES('a','R_OLD','{\"summary\":\"retired\"}',1,'t','retired')",
		)
		.run();
	await raw
		.prepare(
			"INSERT INTO repo_meta(account_id,identity_key,category,category_source,updated_at) VALUES('a','R_OLD','profile','agent','t')",
		)
		.run();
	await raw
		.prepare(
			"INSERT INTO refresh_catalog(account_id,repo_id,repo,discovered_day,timezone,payload,fetched_at) VALUES('a','R_NEW','nocoo/app','2026-10-29','Asia/Shanghai','{}','t')",
		)
		.run();
	expect(await readRepoAgentState(db, "a", "nocoo/app")).toMatchObject({
		payload: null,
		revision: null,
	});
	expect(await readRepoMeta(db, "a", "nocoo/app")).toMatchObject({ category: null });
	expect(
		await writeRepoAgentState(db, "a", "nocoo/app", { payload: { summary: "current" } }, "fixture"),
	).toMatchObject({ revision: 2 });
	await writeRepoMeta(db, "a", "nocoo/app", { category: "app" });
	for (const table of ["repo_agent_state", "repo_meta"])
		expect(
			(await raw.prepare(`SELECT identity_key FROM ${table} ORDER BY identity_key`).all()).results,
		).toEqual([{ identity_key: "R_NEW" }, { identity_key: "R_OLD" }]);
	await raw.prepare("UPDATE refresh_catalog SET active=0").run();
	await expect(readRepoAgentState(db, "a", "nocoo/app")).rejects.toMatchObject({ status: 404 });
	await expect(
		writeRepoAgentState(db, "a", "nocoo/app", { payload: {} }, "fixture"),
	).rejects.toMatchObject({ status: 404 });
	await expect(readRepoMeta(db, "a", "nocoo/app")).rejects.toMatchObject({ status: 404 });
	await expect(writeRepoMeta(db, "a", "nocoo/app", { category: "app" })).rejects.toMatchObject({
		status: 404,
	});
});

it("does not expose retired catalog events as current refresh history", async () => {
	const { raw, db } = await fixture();
	await raw
		.prepare(
			"INSERT INTO catalog_state(account_id,history_since,checked_at,revision) VALUES('a','2026-10-29T00:00:00.000Z','2026-10-29T00:00:00.000Z',1)",
		)
		.run();
	await expect(
		readCatalogChanges(db, "a", { since: ["2026-10-29T00:00:00.000Z"] }),
	).rejects.toMatchObject({ status: 409, code: "catalog_unpublished" });
});
