import { expect, it } from "vitest";
import { github } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import {
	beginCatalog,
	type CatalogRow,
	catalogIdentity,
	catalogPlanWrites,
	catalogRetentionWrites,
	planCatalog,
} from "./catalog-history";
import { catalogInclude, catalogView, readCatalogChanges } from "./catalog-read";
import { createDb } from "./db/d1";
import { factoryStorage } from "./factory-retention";
import { MAX_FETCHES } from "./github-client";

const now = "2026-10-22T00:00:00.000Z";
const cutoff = "2026-07-24T00:00:00.000Z";
const old = "2026-07-23T23:59:59.999Z";
const middle = "2026-10-01T00:00:00.000Z";

async function fixture() {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','nocoo','fake','fake',?,?),('b','other','fake','fake',?,?)",
		)
		.bind(now, now, now, now)
		.run();
	await raw
		.prepare(
			"INSERT INTO catalog_state(account_id,history_since,checked_at,revision) VALUES('a','2026-01-01T00:00:00.000Z',?,1),('b','2026-01-01T00:00:00.000Z',?,1)",
		)
		.bind(now, now)
		.run();
	const db = createDb(raw);
	const events = async (items: { id: string; at: string }[], account = "a") => {
		await raw
			.prepare(
				"INSERT INTO catalog_changes(account_id,event_id,kind,repo,at,source_kind,details) SELECT ?,json_extract(value,'$.id'),'added','nocoo/app',json_extract(value,'$.at'),'legacy','{}' FROM json_each(?)",
			)
			.bind(account, JSON.stringify(items))
			.run();
	};
	const repositories = async (items: { id: string; removed: string | null }[], account = "a") => {
		await raw
			.prepare(
				"INSERT INTO catalog_repositories(account_id,identity_key,repo,row_payload,first_seen_at,last_seen_at,removed_at,is_archived,visibility,is_fork,first_seen_source) SELECT ?,json_extract(value,'$.id'),'nocoo/'||json_extract(value,'$.id'),json_object('name_with_owner','nocoo/'||json_extract(value,'$.id'),'description','🦒 retained evidence'),?,?,json_extract(value,'$.removed'),0,'PUBLIC',0,'github_catalog' FROM json_each(?)",
			)
			.bind(account, old, old, JSON.stringify(items))
			.run();
	};
	const count = async (table: string, account = "a") =>
		(
			await raw
				.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE account_id=?`)
				.bind(account)
				.first<{ count: number }>()
		)?.count;
	const floor = async () =>
		(
			await raw
				.prepare("SELECT history_since FROM catalog_state WHERE account_id='a'")
				.first<{ history_since: string }>()
		)?.history_since;
	return {
		raw,
		db,
		events,
		repositories,
		count,
		floor,
		prune: () => db.batch(catalogRetentionWrites(db, "a", now)),
	};
}

it("R7 retention preserves the exact ninety-day boundary and rejects only expired inclusive cursors", async () => {
	const context = await fixture();
	await context.events([
		{ id: "old", at: old },
		{ id: "edge", at: cutoff },
		{ id: "new", at: middle },
	]);
	await context.events([{ id: "foreign", at: old }], "b");
	await context.prune();
	expect(await context.count("catalog_changes")).toBe(2);
	expect(await context.count("catalog_changes", "b")).toBe(1);
	expect(await context.floor()).toBe(cutoff);
	expect(
		(await readCatalogChanges(context.db, "a", { since: [cutoff] })).added.map(
			(event) => event.event_id,
		),
	).toEqual(["edge", "new"]);
	await expect(readCatalogChanges(context.db, "a", { since: [old] })).rejects.toMatchObject({
		status: 410,
		code: "catalog_history_expired",
	});
	await context.prune();
	expect(await context.floor()).toBe(cutoff);
	expect(await context.count("catalog_changes")).toBe(2);
});

it("R7 retention evicts a whole overflowing timestamp cohort instead of losing cursor-addressable events", async () => {
	const context = await fixture();
	await context.events([
		{ id: "cohort-first", at: middle },
		{ id: "cohort-second", at: middle },
		...Array.from({ length: 9999 }, (_, index) => ({ id: `new-${index}`, at: now })),
	]);
	await context.prune();
	expect(await context.count("catalog_changes")).toBe(9999);
	expect(await context.floor()).toBe("2026-10-01T00:00:00.001Z");
	await expect(readCatalogChanges(context.db, "a", { since: [middle] })).rejects.toMatchObject({
		status: 410,
	});
	expect(
		(await readCatalogChanges(context.db, "a", { since: ["2026-10-01T00:00:00.001Z"] })).added,
	).toHaveLength(9999);
	await context.prune();
	expect(await context.floor()).toBe("2026-10-01T00:00:00.001Z");
});

it("R7 retention keeps exactly ten thousand events without prematurely advancing past their timestamp", async () => {
	const context = await fixture();
	await context.events(
		Array.from({ length: 10000 }, (_, index) => ({ id: `event-${index}`, at: middle })),
	);
	await context.prune();
	expect(await context.count("catalog_changes")).toBe(10000);
	expect(await context.floor()).toBe(cutoff);
	expect((await readCatalogChanges(context.db, "a", { since: [middle] })).added).toHaveLength(
		10000,
	);
});

it("R7 removed-row retention preserves current membership and immutable or generic history", async () => {
	const context = await fixture();
	await context.repositories([
		{ id: "old", removed: old },
		{ id: "edge", removed: cutoff },
		{ id: "current", removed: null },
	]);
	await context.repositories([{ id: "foreign", removed: old }], "b");
	await context.raw
		.prepare(
			"INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES('a','repo:nocoo/old:details','{\"name\":\"immutable\"}',?)",
		)
		.bind(old)
		.run();
	await context.raw
		.prepare(
			"INSERT INTO factory_repo_versions(account_id,repo,version,payload,refreshed_at) VALUES('a','nocoo/old','historical','{\"name\":\"immutable\"}',?)",
		)
		.bind(old)
		.run();
	await context.raw
		.prepare(
			"INSERT INTO agent_resources(account_id,collection,id,repository,type,status,payload,created_at,updated_at) VALUES('a','records','saved','nocoo/old','external','completed','{\"note\":\"preserve\"}',?,?)",
		)
		.bind(old, old)
		.run();
	const saved = async () =>
		Promise.all(
			["snapshots", "factory_repo_versions", "agent_resources"].map((table) =>
				context.raw.prepare(`SELECT * FROM ${table} WHERE account_id='a'`).all(),
			),
		);
	const before = await saved();
	await context.prune();
	expect(
		await context.raw
			.prepare(
				"SELECT identity_key FROM catalog_repositories WHERE account_id='a' ORDER BY identity_key",
			)
			.all(),
	).toMatchObject({ results: [{ identity_key: "current" }, { identity_key: "edge" }] });
	expect(await context.count("catalog_repositories", "b")).toBe(1);
	expect(await saved()).toEqual(before);
});

it("R7 removed-row count cap evicts whole oldest cohorts without deleting active identities", async () => {
	const context = await fixture();
	await context.repositories([
		{ id: "old-first", removed: middle },
		{ id: "old-second", removed: middle },
		...Array.from({ length: 999 }, (_, index) => ({ id: `departed-${index}`, removed: now })),
		...Array.from({ length: 8 }, (_, index) => ({ id: `active-${index}`, removed: null })),
	]);
	await context.prune();
	expect(await context.count("catalog_repositories")).toBe(1007);
	expect(
		await context.raw
			.prepare(
				"SELECT COUNT(*) AS count FROM catalog_repositories WHERE account_id='a' AND removed_at IS NULL",
			)
			.first(),
	).toEqual({ count: 8 });
	expect(
		await context.raw
			.prepare(
				"SELECT COUNT(*) AS count FROM catalog_repositories WHERE account_id='a' AND removed_at=?",
			)
			.bind(middle)
			.first(),
	).toEqual({ count: 0 });
});

it("R7 catalog storage accounts for UTF-8 metadata and releases removed payload bytes after retention", async () => {
	const context = await fixture();
	const before = await factoryStorage(context.db, "a");
	await context.repositories([{ id: "obsolete", removed: old }]);
	await context.events([{ id: "expired", at: old }]);
	await context.raw
		.prepare("UPDATE catalog_changes SET details=? WHERE account_id='a'")
		.bind(JSON.stringify({ after: "🦒".repeat(100) }))
		.run();
	const added = await factoryStorage(context.db, "a");
	const persisted = (
		await context.raw
			.prepare("SELECT * FROM catalog_repositories WHERE account_id='a'")
			.all<Record<string, unknown>>()
	).results[0];
	const event = (
		await context.raw
			.prepare("SELECT * FROM catalog_changes WHERE account_id='a'")
			.all<Record<string, unknown>>()
	).results[0];
	const utf8 = (row: Record<string, unknown> | undefined) =>
		new TextEncoder().encode(
			Object.entries(row ?? {})
				.filter(([key, value]) => key !== "account_id" && typeof value === "string")
				.map(([, value]) => value)
				.join(""),
		).length;
	expect(added.totalBytes - before.totalBytes).toBe(utf8(persisted) + utf8(event));
	expect(added.resourceBytes).toBe(before.resourceBytes);
	await context.prune();
	expect((await factoryStorage(context.db, "a")).totalBytes).toBe(before.totalBytes);
});

it.each([
	{ repos: [], truncated: true },
	{ repos: [], unavailable: true },
	{ repos: [], forbidden: true },
	{},
])("R7 incomplete history plans retain rows and completion time: %j", async (payload) => {
	const context = await fixture();
	await context.repositories([{ id: "current", removed: null }]);
	const before = await context.raw
		.prepare("SELECT * FROM catalog_repositories ORDER BY identity_key")
		.all();
	const gh = github(() => {
		throw new Error("incomplete catalog must not confirm removal");
	});
	const plan = await planCatalog(
		await beginCatalog(context.db, "a"),
		{ truncated: false, ...payload },
		{},
		"nocoo",
		gh,
		"fixture",
		"2026-10-23T00:00:00.000Z",
		{ kind: "legacy", runId: null },
	);
	expect(plan.complete).toBe(false);
	await context.db.batch(catalogPlanWrites(context.db, "a", plan));
	expect(
		await context.raw.prepare("SELECT * FROM catalog_repositories ORDER BY identity_key").all(),
	).toEqual(before);
	expect(
		await context.raw
			.prepare("SELECT checked_at,warning_code FROM catalog_state WHERE account_id='a'")
			.first(),
	).toEqual({ checked_at: now, warning_code: "catalog_incomplete" });
	expect(await context.count("catalog_changes")).toBe(0);
	expect(gh.count).toBe(0);
});

it("R7 exhausted confirmation budgets preserve unconfirmed membership and original observation time", async () => {
	const context = await fixture();
	await context.repositories([{ id: "current", removed: null }]);
	const gh = github(() => {
		throw new Error("exhausted client must not fetch");
	});
	gh.count = MAX_FETCHES;
	const plan = await planCatalog(
		await beginCatalog(context.db, "a"),
		{ repos: [], truncated: false },
		{},
		"nocoo",
		gh,
		"fixture",
		"2026-10-23T00:00:00.000Z",
		{ kind: "legacy", runId: null },
	);
	expect(plan.removed).toEqual([]);
	expect(plan.rows[0]).toMatchObject({
		repo: "nocoo/current",
		last_seen_at: old,
		removed_at: null,
	});
	expect(plan.warning).toBe("catalog_removal_unconfirmed");
	expect(gh.count).toBe(MAX_FETCHES);
});

it("R7 unverifiable scope preserves membership without attempting an unauthorized lookup", async () => {
	const context = await fixture();
	await context.repositories([{ id: "current", removed: null }]);
	const gh = github(() => Response.json({ message: "fixture denial" }, { status: 401 }));
	await expect(
		planCatalog(
			await beginCatalog(context.db, "a"),
			{ repos: [], truncated: false },
			{},
			"nocoo",
			gh,
			"fixture",
			"2026-10-23T00:00:00.000Z",
			{ kind: "legacy", runId: null },
		),
	).resolves.toMatchObject({
		removed: [],
		unconfirmed: [{ reason: "scope_unverifiable" }],
		warning: "catalog_removal_unconfirmed",
	});
	expect(await context.count("catalog_changes")).toBe(0);
	expect(
		await context.raw.prepare("SELECT checked_at FROM catalog_state WHERE account_id='a'").first(),
	).toEqual({ checked_at: now });
});

it.each([
	{ repos: [{ name_with_owner: "invalid" }], status: 502, code: "github_error" },
	{
		repos: [{ name_with_owner: "nocoo/repeated" }, { name_with_owner: "nocoo/repeated" }],
		status: 409,
		code: "catalog_identity_conflict",
	},
	{
		repos: Array.from({ length: 501 }, (_, index) => ({ name_with_owner: `nocoo/item-${index}` })),
		status: 422,
		code: "catalog_capacity",
	},
	{
		repos: [{ name_with_owner: "nocoo/large", description: "🦒".repeat(4000) }],
		status: 422,
		code: "catalog_capacity",
	},
])(
	"R7 rejects invalid or oversized discovery input without writes: $code",
	async ({ repos, status, code }) => {
		const context = await fixture();
		const gh = github(() => {
			throw new Error("invalid new catalog must not fetch");
		});
		await expect(
			planCatalog(
				await beginCatalog(context.db, "a"),
				{ repos, truncated: false },
				{},
				"nocoo",
				gh,
				"fixture",
				"2026-10-23T00:00:00.000Z",
				{ kind: "legacy", runId: null },
			),
		).rejects.toMatchObject({ status, code });
		expect(await context.count("catalog_changes")).toBe(0);
		expect(await context.count("catalog_repositories")).toBe(0);
	},
);

it.each([
	{ include: ["all"] },
	{ include: ["removed", "removed"] },
	{ scope: ["all", "starred"] },
	{ unexpected: ["value"] },
])("R7 inclusion rejects unsupported or repeated selectors: %j", (query) => {
	expect(() => catalogInclude(query)).toThrowError("Invalid repository");
});

it("R7 legacy catalog seeding keeps unknown times and IDs unknown without leaking identity metadata into rows", async () => {
	const context = await fixture();
	const payload = {
		repos: [
			null,
			{},
			{ name_with_owner: 7 },
			{ name_with_owner: "nocoo/private", is_private: true },
		],
		fetched_at: "invalid",
	};
	expect(catalogIdentity(payload)).toEqual({});
	catalogIdentity(payload, { "nocoo/private": "R_private" });
	expect(catalogIdentity(payload)).toEqual({ "nocoo/private": "R_private" });
	expect(JSON.stringify(payload)).not.toContain("R_private");
	await context.raw
		.prepare(
			"INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES('a','repos',?,'invalid')",
		)
		.bind(JSON.stringify(payload))
		.run();
	const baseline = await beginCatalog(context.db, "a");
	expect(baseline.rows).toHaveLength(1);
	expect(baseline.rows[0]).toMatchObject({
		github_id: null,
		first_seen_at: null,
		last_seen_at: null,
		visibility: "PRIVATE",
		first_seen_source: "saved_catalog",
	});
	await expect(beginCatalog({ ...context.db, batch: async () => [] }, "a")).rejects.toMatchObject({
		status: 500,
		code: "db_error",
	});
});

it("R7 absent current identity evidence preserves a previously known stable ID by name", async () => {
	const context = await fixture();
	await context.repositories([{ id: "current", removed: null }]);
	await context.raw
		.prepare("UPDATE catalog_repositories SET github_id='R_known' WHERE account_id='a'")
		.run();
	const gh = github(() => {
		throw new Error("same known name needs no extra lookup");
	});
	const plan = await planCatalog(
		await beginCatalog(context.db, "a"),
		{ repos: [{ name_with_owner: "nocoo/current" }], truncated: false },
		{},
		"nocoo",
		gh,
		"fixture",
		"2026-10-23T00:00:00.000Z",
		{ kind: "legacy", runId: null },
	);
	expect(plan.rows[0]).toMatchObject({
		github_id: "R_known",
		identity_key: "current",
		first_seen_at: old,
	});
	expect(plan.warning).toBe("catalog_identity_unavailable");
	expect(plan.events).toEqual([]);
	expect(plan.removed).toEqual([]);
});

it("R7 adopting a stable ID for a backfilled name preserves first-seen provenance without an added event", async () => {
	const context = await fixture();
	await context.repositories([{ id: "current", removed: null }]);
	await context.raw
		.prepare(
			"UPDATE catalog_repositories SET first_seen_source='saved_catalog' WHERE account_id='a'",
		)
		.run();
	const gh = github(() => {
		throw new Error("identity adoption needs no direct lookup");
	});
	const plan = await planCatalog(
		await beginCatalog(context.db, "a"),
		{ repos: [{ name_with_owner: "nocoo/current" }], truncated: false },
		{ "nocoo/current": "R_adopted" },
		"nocoo",
		gh,
		"fixture",
		"2026-10-23T00:00:00.000Z",
		{ kind: "legacy", runId: null },
	);
	expect(plan.rows[0]).toMatchObject({
		github_id: "R_adopted",
		identity_key: "current",
		first_seen_at: old,
		first_seen_source: "saved_catalog",
	});
	expect(plan.events).toEqual([]);
	expect(plan.warning).toBeNull();
});

it.each([now, middle])(
	"R7 cannot move a complete catalog cutoff backward or replay it: %s",
	async (at) => {
		const context = await fixture();
		const gh = github(() => {
			throw new Error("stale completion must not fetch");
		});
		await expect(
			planCatalog(
				await beginCatalog(context.db, "a"),
				{ repos: [], truncated: false },
				{},
				"nocoo",
				gh,
				"fixture",
				at,
				{ kind: "legacy", runId: null },
			),
		).rejects.toMatchObject({ status: 409, code: "catalog_conflict" });
		expect(await context.count("catalog_changes")).toBe(0);
		expect(gh.count).toBe(0);
	},
);

it("R7 catalog views retain nullable provenance and explicitly opt into removed identities", async () => {
	const context = await fixture();
	await context.repositories([
		{ id: "removed", removed: middle },
		{ id: "current", removed: null },
	]);
	const rows = (
		await context.raw
			.prepare("SELECT * FROM catalog_repositories WHERE account_id='a' ORDER BY identity_key")
			.all<CatalogRow>()
	).results;
	expect(catalogView(null, rows, true)).toBeNull();
	expect(catalogView({}, rows)).toEqual({});
	expect(catalogInclude({})).toBe(false);
	expect(catalogInclude({ include: ["removed"], scope: ["all"] })).toBe(true);
	const snapshot = {
		fetched_at: now,
		repos: [
			{ name_with_owner: "NOCOO/CURRENT", description: "unchanged wire" },
			{ name_with_owner: "nocoo/removed" },
			{ name_with_owner: "nocoo/untracked", first_seen_at: middle, archived_changed_at: now },
		],
	};
	expect(catalogView(snapshot, rows)).toMatchObject({
		repos: [
			{
				name_with_owner: "NOCOO/CURRENT",
				description: "unchanged wire",
				first_seen_at: old,
				last_seen_at: old,
				removed_at: null,
				archived_changed_at: null,
			},
			{
				name_with_owner: "nocoo/untracked",
				first_seen_at: middle,
				last_seen_at: null,
				removed_at: null,
				archived_changed_at: now,
			},
		],
	});
	expect(catalogView(snapshot, rows, true)?.repos).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name_with_owner: "nocoo/removed",
				removed_at: middle,
				first_seen_at: old,
				last_seen_at: old,
			}),
		]),
	);
});

it("R7 history refuses an unpruned overflow or future cursor rather than claiming a truncated complete result", async () => {
	const context = await fixture();
	await context.events(
		Array.from({ length: 10001 }, (_, index) => ({ id: `event-${index}`, at: middle })),
	);
	await expect(readCatalogChanges(context.db, "a", { since: [middle] })).rejects.toMatchObject({
		status: 409,
		code: "catalog_capacity",
	});
	await expect(
		readCatalogChanges(context.db, "a", { since: ["2026-10-23T00:00:00.000Z"] }),
	).rejects.toMatchObject({ status: 400, code: "validation_failed" });
	await expect(
		readCatalogChanges({ ...context.db, batch: async () => [] }, "a", { since: [middle] }),
	).rejects.toMatchObject({ status: 500, code: "db_error" });
});

it("R7 persisted repository and change payload checks enforce actual UTF-8 bytes at their exact limits", async () => {
	const context = await fixture();
	await context.repositories([{ id: "edge", removed: null }]);
	await context.events([{ id: "edge", at: now }]);
	const exactJson = (limit: number) => {
		const base = JSON.stringify({ value: "🦒" });
		return JSON.stringify({
			value: `🦒${"x".repeat(limit - new TextEncoder().encode(base).length)}`,
		});
	};
	const repo = exactJson(16000);
	const event = exactJson(1024);
	await context.raw
		.prepare("UPDATE catalog_repositories SET row_payload=? WHERE account_id='a'")
		.bind(repo)
		.run();
	await context.raw
		.prepare("UPDATE catalog_changes SET details=? WHERE account_id='a'")
		.bind(event)
		.run();
	await expect(
		context.raw
			.prepare("UPDATE catalog_repositories SET row_payload=? WHERE account_id='a'")
			.bind(`${repo} `)
			.run(),
	).rejects.toThrow();
	await expect(
		context.raw
			.prepare("UPDATE catalog_changes SET details=? WHERE account_id='a'")
			.bind(`${event} `)
			.run(),
	).rejects.toThrow();
	expect(
		await context.raw
			.prepare("SELECT row_payload FROM catalog_repositories WHERE account_id='a'")
			.first(),
	).toEqual({ row_payload: repo });
	expect(
		await context.raw.prepare("SELECT details FROM catalog_changes WHERE account_id='a'").first(),
	).toEqual({ details: event });
});
