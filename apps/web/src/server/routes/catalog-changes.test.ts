import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { github } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";
import { createApiToken } from "../lib/api-tokens";
import { beginCatalog, catalogPlanWrites, planCatalog } from "../lib/catalog-history";
import { createDb } from "../lib/db/d1";
import { replaceSnapshotStmts } from "../lib/db/snapshots";

async function fixture(scopes: ("observations:read" | "app:read")[] = ["observations:read"]) {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES('a','nocoo','fake','fake',1,'2026-10-21','2026-10-21')",
		)
		.run();
	await db.batch(
		await replaceSnapshotStmts(db, "a", "repos", { repos: [] }, "2026-10-21T00:00:00.000Z"),
	);
	const token = await createApiToken(db, {
		accountId: "a",
		label: "catalog-fixture",
		scopes,
		expiresInDays: 1,
		creator: "fixture@local.test",
	});
	const env = { DB: raw, ENVIRONMENT: "development" } as Env;
	const app = createApp();
	const request = (
		query = "since=2026-10-21T00%3A00%3A00.000Z",
		options: { account?: string; token?: string; method?: string; tag?: string } = {},
	) =>
		app.request(
			`http://localhost/api/v1/accounts/${options.account ?? "a"}/catalog/changes?${query}`,
			{
				method: options.method ?? "GET",
				headers: {
					Authorization: `Bearer ${options.token ?? token.token}`,
					...(options.tag ? { "If-None-Match": options.tag } : {}),
				},
			},
			env,
		);
	return { raw, request };
}

it("R7 catalog changes is explicitly uninitialized instead of fabricating an empty complete history", async () => {
	const context = await fixture();
	const before = await context.raw.prepare("SELECT * FROM snapshots ORDER BY kind").all();
	const tokensBefore = await context.raw.prepare("SELECT * FROM api_tokens ORDER BY id").all();
	const response = await context.request();
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ error: { code: "catalog_unpublished" } });
	expect(response.headers.get("cache-control")).toBe("private, no-store");
	expect(await context.raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(before);
	expect(await context.raw.prepare("SELECT * FROM api_tokens ORDER BY id").all()).toEqual(
		tokensBefore,
	);
});

it("B6 keeps the migration history floor after first publication without inventing prehistory removals", async () => {
	const context = await fixture();
	const db = createDb(context.raw);
	const savedAt = "2026-10-21T11:30:23.494Z";
	const repos = [
		{ name_with_owner: "nocoo/giraffe", is_archived: false },
		{ name_with_owner: "nocoo/snaky", is_archived: true },
	];
	await db.batch(await replaceSnapshotStmts(db, "a", "repos", { repos }, savedAt));
	await db.batch(
		readFileSync("migrations/0019_catalog_history.sql", "utf8")
			.split(";")
			.map((sql) => sql.trim())
			.filter(Boolean)
			.map((sql) => db.prepare(sql)),
	);
	const state = await context.raw
		.prepare("SELECT history_since,checked_at FROM catalog_state WHERE account_id='a'")
		.first<{ history_since: string; checked_at: string | null }>();
	if (!state) throw new Error("missing migrated catalog state");
	expect(state.checked_at).toBeNull();
	expect(state.history_since > savedAt).toBe(true);
	const beforeFloor = new Date(Date.parse(state.history_since) - 1).toISOString();
	expect((await context.request(`since=${beforeFloor}`)).status).toBe(409);
	const gh = github(() => {
		throw new Error("the saved catalog must not synthesize missing-repository lookups");
	});
	const at = new Date(Date.parse(state.history_since) + 1000).toISOString();
	const plan = await planCatalog(
		await beginCatalog(db, "a"),
		{ repos, truncated: false },
		{ "nocoo/giraffe": "R_giraffe", "nocoo/snaky": "R_snaky" },
		"nocoo",
		gh,
		"fixture",
		at,
		{ kind: "factory", runId: "first-catalog" },
	);
	await db.batch(catalogPlanWrites(db, "a", plan));
	const expired = await context.request(`since=${beforeFloor}`);
	expect(expired.status).toBe(410);
	expect(await expired.json()).toMatchObject({ error: { code: "catalog_history_expired" } });
	const boundary = await context.request(`since=${state.history_since}`);
	expect(boundary.status).toBe(200);
	expect(await boundary.json()).toMatchObject({
		since: state.history_since,
		history_since: state.history_since,
		until: at,
		added: [],
		removed: [],
		archived: [],
		unconfirmed: [],
	});
	expect(
		await context.raw
			.prepare(
				"SELECT repo,removed_at FROM catalog_repositories WHERE account_id='a' ORDER BY repo",
			)
			.all(),
	).toMatchObject({
		results: [
			{ repo: "nocoo/giraffe", removed_at: null },
			{ repo: "nocoo/snaky", removed_at: null },
		],
	});
	for (const repo of ["nocoo/rsshub", "nocoo/wiki"])
		expect(plan.rows.some((row) => row.repo === repo)).toBe(false);
	expect(gh.count).toBe(0);
});

it.each([
	"",
	"since=",
	"since=yesterday",
	"since=2026-10-21",
	"since=2026-10-21T00%3A00%3A00",
	"since=2026-02-30T00%3A00%3A00Z",
	"since=2026-10-21T00%3A00%3A00Z&since=2026-10-21T00%3A00%3A00Z",
	"since=2026-10-21T00%3A00%3A00Z&scope=all",
	"since=2026-10-21T00%3A00%3A00Z&include=removed",
])(
	"R7 catalog changes rejects malformed, missing, duplicate or unknown filters: %s",
	async (query) => {
		const context = await fixture();
		const response = await context.request(query);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
	},
);

it("R7 catalog changes enforces account-bound observation credentials and observation-only methods", async () => {
	const context = await fixture();
	expect((await context.request(undefined, { token: "invalid-fixture-token" })).status).toBe(401);
	expect((await context.request(undefined, { account: "other" })).status).toBe(403);
	expect((await context.request(undefined, { method: "POST" })).status).toBe(405);
	const managementOnly = await fixture(["app:read"]);
	expect((await managementOnly.request()).status).toBe(403);
});

it("R7 catalog changes serves inclusive normalized events and private ETag304 without any saved-data mutation", async () => {
	const context = await fixture();
	const at = "2026-10-22T00:00:00.000Z";
	await context.raw
		.prepare(
			"INSERT INTO catalog_state(account_id,history_since,checked_at,revision) VALUES('a',?,?,1)",
		)
		.bind(at, at)
		.run();
	for (const repo of ["nocoo/z", "nocoo/a"])
		await context.raw
			.prepare(
				"INSERT INTO catalog_changes(account_id,event_id,kind,repo,github_id,at,source_kind,source_run_id,details) VALUES('a',?,'added',?,?,?,'factory','catalog-run','{}')",
			)
			.bind(repo, repo, `R_${repo}`, at)
			.run();
	const before = await context.raw.prepare("SELECT * FROM api_tokens").all();
	const response = await context.request(
		`since=${encodeURIComponent("2026-10-22T08:00:00+08:00")}`,
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		since: at,
		until: at,
		added: [
			{ repo: "nocoo/a", source: { kind: "factory", runId: "catalog-run" } },
			{ repo: "nocoo/z" },
		],
	});
	const tag = response.headers.get("etag");
	expect(tag).toMatch(/^"[a-f0-9]+"$/);
	const conditional = await context.request(`since=${at}`, { tag: `W/${tag}` });
	expect(conditional.status).toBe(304);
	expect(await conditional.text()).toBe("");
	expect(conditional.headers.get("cache-control")).toBe("private, no-store");
	expect(conditional.headers.get("vary")).toBe("Authorization");
	expect(await context.raw.prepare("SELECT * FROM api_tokens").all()).toEqual(before);
	expect((await context.request("since=invalid", { tag: "*" })).status).toBe(400);
});
