import { expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";
import { createApiToken } from "../lib/api-tokens";
import { createDb } from "../lib/db/d1";
import { replaceSnapshotStmts } from "../lib/db/snapshots";
import { readSources } from "../lib/machine-sources";
import { readStars } from "../lib/repo-stars";
import { snapshotSelection } from "../lib/snapshot-scope";

const account = "s".repeat(21);
const at = "2026-10-22T00:00:00.000Z";
async function fixture() {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?,'owner','fake','fake',1,?,?)",
		)
		.bind(account, at, at)
		.run();
	await db.batch(
		await replaceSnapshotStmts(
			db,
			account,
			"repos",
			{
				repos: ["owner/app", "owner/unseen", "external/repo"].map((name_with_owner) => ({
					name_with_owner,
				})),
			},
			at,
		),
	);
	const token = await createApiToken(db, {
		accountId: account,
		label: "local stars",
		scopes: ["app:read", "app:write", "observations:read"],
		expiresInDays: 1,
		creator: "fixture@local.test",
	});
	const app = createApp();
	const env = { DB: raw, ENVIRONMENT: "development", GITHUB_API_BASE: "http://fixture" } as Env;
	const machine = (
		method: string,
		repo = "owner/app",
		body?: string,
		headers: Record<string, string> = {},
	) =>
		app.request(
			`http://localhost/api/v1/accounts/${account}/stars${repo ? `/${repo}` : ""}`,
			{
				method,
				headers: {
					Authorization: `Bearer ${token.token}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
					...headers,
				},
				...(body === undefined ? {} : { body }),
			},
			env,
		);
	const owner = (enabled: boolean, extra: Record<string, unknown> = {}, repo = "owner/app") =>
		app.request(
			`http://localhost/api/repos/${repo}/star`,
			{
				method: "POST",
				headers: { origin: "https://giraffe.dev.hexly.ai", "content-type": "application/json" },
				body: JSON.stringify({ account_id: account, enabled, ...extra }),
			},
			env,
		);
	return { raw, db, app, env, machine, owner, token };
}

it("mints agent provenance, lists tombstones, and keeps settings and every selector true-star only", async () => {
	const setup = await fixture();
	const created = await setup.machine(
		"PUT",
		"OWNER/APP",
		JSON.stringify({ reason: "daily collection" }),
	);
	expect(created.status).toBe(200);
	expect(await created.json()).toEqual({
		repo: "owner/app",
		starred: true,
		source: "agent",
		updated_at: expect.any(String),
		reason: "daily collection",
	});
	expect((await setup.owner(false)).status).toBe(200);
	const before = await setup.raw.prepare("SELECT * FROM repo_stars").all();
	const listed = await setup.machine("GET", "");
	expect(listed.status).toBe(200);
	expect(await listed.json()).toEqual({
		items: [
			{
				repo: "owner/app",
				starred: false,
				source: "owner",
				updated_at: expect.any(String),
				reason: null,
			},
		],
	});
	expect(await setup.raw.prepare("SELECT * FROM repo_stars").all()).toEqual(before);
	expect(
		(await readStars(setup.db, account)).filter((star) => star.starred).map((star) => star.repo),
	).toEqual([]);
	expect((await snapshotSelection(setup.db, account, "starred")).starred("OWNER/APP")).toBe(false);
	expect((await readSources(setup.db, account, {})).repositories).toEqual([
		"owner/app",
		"owner/unseen",
	]);
	const settings = await setup.app.request(
		`http://localhost/api/v1/accounts/${account}/settings`,
		{ headers: { Authorization: `Bearer ${setup.token.token}` } },
		setup.env,
	);
	expect(settings.status).toBe(200);
	expect(await settings.json()).toMatchObject({ stars: [] });
	const repos = (await (
		await setup.app.request("http://localhost/api/repos", {}, setup.env)
	).json()) as {
		repos: unknown[];
	};
	expect(repos.repos).toEqual([
		expect.objectContaining({
			name_with_owner: "owner/app",
			starred: false,
			star_source: "owner",
			star_updated_at: expect.any(String),
		}),
		expect.objectContaining({
			name_with_owner: "owner/unseen",
			starred: false,
			star_source: null,
			star_updated_at: null,
		}),
	]);
});

it.each([true, false])(
	"lets agent writes replace owner %s in both directions with informational provenance",
	async (starred) => {
		const setup = await fixture();
		const owner = await setup.owner(starred, { reason: "manual intent" });
		expect(owner.status).toBe(200);
		expect(await owner.json()).toMatchObject({
			account_id: account,
			name_with_owner: "owner/app",
			starred,
			star_source: "owner",
			star_updated_at: expect.any(String),
		});
		const opposite = await setup.machine(
			starred ? "DELETE" : "PUT",
			"OWNER/APP",
			JSON.stringify({ reason: "agent opposite" }),
		);
		expect(opposite.status).toBe(200);
		expect(await opposite.json()).toMatchObject({
			starred: !starred,
			source: "agent",
			reason: "agent opposite",
		});
		expect(await setup.raw.prepare("SELECT last_used_at FROM api_tokens").first()).toMatchObject({
			last_used_at: expect.any(String),
		});
		expect((await setup.owner(starred, { reason: "manual intent again" })).status).toBe(200);
		const same = await setup.machine(
			starred ? "PUT" : "DELETE",
			"owner/APP",
			JSON.stringify({ reason: "agent same direction" }),
		);
		expect(same.status).toBe(200);
		expect(await same.json()).toEqual({
			repo: "owner/app",
			starred,
			source: "agent",
			updated_at: expect.any(String),
			reason: "agent same direction",
		});
		expect(await setup.raw.prepare("SELECT starred,source,reason FROM repo_stars").first()).toEqual(
			{
				starred: Number(starred),
				source: "agent",
				reason: "agent same direction",
			},
		);
	},
);

it("accepts missing reason bodies, persists agent unstars and allows catalog-only external stars", async () => {
	const setup = await fixture();
	for (const method of ["PUT", "DELETE"] as const) {
		const response = await setup.machine(method, "external/repo");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			repo: "external/repo",
			starred: method === "PUT",
			source: "agent",
			updated_at: expect.any(String),
			reason: null,
		});
	}
	expect((await setup.machine("PUT", "owner/missing")).status).toBe(404);
	expect((await setup.owner(true, { source: "agent" })).status).toBe(400);
	expect(
		(await setup.machine("PUT", "owner/app", JSON.stringify({ source: "owner" }))).status,
	).toBe(400);
});

it("accepts the reason boundary, rejects non-JSON bodies, and scopes star listing to app readers", async () => {
	const setup = await fixture();
	const reason = "x".repeat(200);
	const response = await setup.machine("PUT", "owner/app", JSON.stringify({ reason }));
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ reason });
	expect(
		(await setup.machine("PUT", "owner/app", "{}", { "content-type": "text/plain" })).status,
	).toBe(400);
	expect(
		(
			await setup.app.request(
				`http://localhost/api/v1/accounts/${account}/stars?extra=1`,
				{ headers: { Authorization: `Bearer ${setup.token.token}` } },
				setup.env,
			)
		).status,
	).toBe(400);
	const readOnly = await createApiToken(setup.db, {
		accountId: account,
		label: "observation only",
		scopes: ["observations:read"],
		expiresInDays: 1,
		creator: "fixture@local.test",
	});
	expect(
		(await setup.machine("GET", "", undefined, { Authorization: `Bearer ${readOnly.token}` }))
			.status,
	).toBe(403);
	expect((await setup.machine("GET", "", undefined, { Authorization: "" })).status).toBe(401);
});

it.each([
	"{",
	"null",
	"[]",
	'{"reason":42}',
	JSON.stringify({ reason: "x".repeat(201) }),
	'{"starred":true}',
	" ",
])("rejects malformed optional star bodies without changing state: %s", async (body) => {
	const setup = await fixture();
	for (const method of ["PUT", "DELETE"] as const)
		expect((await setup.machine(method, "owner/app", body)).status).toBe(400);
	expect((await setup.raw.prepare("SELECT * FROM repo_stars").all()).results).toEqual([]);
});

it("lets the last star write win when an owner arrives after the agent catalog read", async () => {
	const setup = await fixture();
	const prepare = setup.raw.prepare.bind(setup.raw);
	let injected = false;
	vi.spyOn(setup.raw, "prepare").mockImplementation((sql) => {
		if (!injected && sql.startsWith("INSERT INTO repo_stars")) {
			injected = true;
			void prepare(
				"INSERT INTO repo_stars(account_id,repo,starred,source,updated_at,reason) VALUES(?,'OWNER/APP',0,'owner',?,'late owner')",
			)
				.bind(account, at)
				.run();
		}
		return prepare(sql);
	});
	const response = await setup.machine("PUT");
	expect(response.status).toBe(200);
	expect(injected).toBe(true);
	expect(
		(await prepare("SELECT repo,starred,source,updated_at,reason FROM repo_stars").all()).results,
	).toEqual([
		{
			repo: "OWNER/APP",
			starred: 1,
			source: "agent",
			updated_at: expect.any(String),
			reason: null,
		},
	]);
});

it("fails closed when D1 omits the saved star result", async () => {
	const setup = await fixture();
	vi.spyOn(setup.raw, "batch").mockResolvedValue([]);
	const response = await setup.machine("PUT");
	expect(response.status).toBe(500);
	expect(await response.json()).toMatchObject({ error: { code: "db_error" } });
	expect((await setup.raw.prepare("SELECT * FROM repo_stars").all()).results).toEqual([]);
});
