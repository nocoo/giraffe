import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { RepoMeta } from "../../apps/web/src/lib/repo-meta";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const account = randomUUID().replaceAll("-", "").slice(0, 21);
const owner = `meta-${account}`;
const repository = `${owner}/app`;
const bearer = `giraffe_${randomBytes(32).toString("base64url")}`;
const reader = `giraffe_${randomBytes(32).toString("base64url")}`;
const wrong = `giraffe_${randomBytes(32).toString("base64url")}`;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
let seeded = false;
function rows(command: string): Record<string, unknown>[] {
	const persist = process.env.GIRAFFE_PERSIST;
	const config = process.env.GIRAFFE_CONFIG;
	if (
		base !== "http://127.0.0.1:17045" ||
		!persist ||
		!config ||
		resolve(persist) !== resolve(".wrangler/e2e") ||
		resolve(config) !== resolve(".wrangler/e2e-run/wrangler.toml")
	)
		throw new Error("dedicated local L2 runner context required");
	const result = execFileSync(
		resolve("node_modules/.bin/wrangler"),
		[
			"d1",
			"execute",
			"giraffe-db",
			"--local",
			`--persist-to=${persist}`,
			`--config=${config}`,
			"--json",
			"--command",
			command,
		],
		{ encoding: "utf8" },
	);
	return (JSON.parse(result) as { results: Record<string, unknown>[] }[]).flatMap(
		(item) => item.results,
	);
}
const marker = () =>
	expect(rows("SELECT value FROM _test_marker WHERE key='env'")).toEqual([{ value: "test" }]);
const request = (
	method = "GET",
	body?: unknown,
	token = bearer,
	name = repository,
	selected = account,
	query = "",
) =>
	fetch(`${base}/api/v1/accounts/${selected}/repos/${name}/meta${query}`, {
		method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
beforeAll(() => {
	marker();
	const now = new Date().toISOString();
	const mint = (token: string, scopes: string[], id: string) =>
		`INSERT INTO api_tokens(id,account_id,token_hash,label,scopes,creator,created_at,expires_at) VALUES(${quote(`${account}-${id}`)},${quote(account)},${quote(createHash("sha256").update(token).digest("hex"))},'repo-meta L2',${quote(JSON.stringify(scopes))},'local test',${quote(now)},${quote(new Date(Date.now() + 86400_000).toISOString())});`;
	seeded = true;
	rows(
		[
			`INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(${quote(account)},${quote(owner)},'test-not-an-encrypted-pat','fake',${quote(now)},${quote(now)});`,
			mint(bearer, ["app:read", "app:write", "observations:read"], "writer"),
			mint(reader, ["app:read"], "reader"),
			mint(wrong, ["observations:read", "agent:read", "agent:write"], "wrong"),
			`INSERT INTO catalog_repositories(account_id,identity_key,github_id,repo,row_payload,first_seen_at,is_archived,visibility,is_fork,first_seen_source) VALUES(${quote(account)},'R_app','R_app',${quote(repository)},${quote(JSON.stringify({ name_with_owner: repository }))},${quote(now)},0,'PUBLIC',0,'github_catalog');`,
			`INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES(${quote(account)},'repos',${quote(JSON.stringify({ repos: [{ name_with_owner: repository }], fetched_at: now, truncated: false }))},${quote(now)});`,
		].join("\n"),
	);
});
afterAll(() => {
	if (seeded) {
		marker();
		rows(`DELETE FROM accounts WHERE id=${quote(account)};`);
	}
});

it("R6 HTTP creates/patches static metadata and exposes it in repos without changing content fingerprints", async () => {
	const empty = await request();
	expect(empty.status).toBe(200);
	expect(await empty.json()).toMatchObject({
		account_id: account,
		created_at: null,
		category: null,
		field_sources: {},
	});
	const list = async () =>
		(
			await fetch(`${base}/api/v1/accounts/${account}/repos`, {
				headers: { authorization: `Bearer ${bearer}` },
			})
		).json() as Promise<{
			sourceVersion: string;
			contentVersion: string;
			data: { repos: unknown[] };
		}>;
	const before = await list();
	expect(
		(
			await request("PUT", {
				created_at: "2020-01-01T08:00:00+08:00",
				category: "app",
				exclusion_reason: "preserved",
			})
		).status,
	).toBe(200);
	const patched = await request("PUT", {
		archived_at: "2026-10-22T00:00:00Z",
		category: "docs-vault",
	});
	expect(patched.status).toBe(200);
	expect(await patched.json()).toMatchObject({
		created_at: "2020-01-01T08:00:00+08:00",
		category: "docs-vault",
		exclusion_reason: "preserved",
		field_sources: {
			created_at: "agent",
			archived_at: "agent",
			category: "agent",
			exclusion_reason: "agent",
		},
	});
	const after = await list();
	expect(after.sourceVersion).toBe(before.sourceVersion);
	expect(after.contentVersion).toBe(before.contentVersion);
	expect(after.data.repos).toEqual([
		expect.objectContaining({ meta: expect.objectContaining({ category: "docs-vault" }) }),
	]);
});

it("R6 HTTP enforces strict metadata validation, scopes, fixed-account boundaries and special-name routes", async () => {
	for (const patch of [
		{},
		{ unknown: true },
		{ created_at: null },
		{ created_at: "2026-10-22" },
		{ category: "other" },
		{ first_seen_at: "2026-10-22T00:00:00Z" },
		{ exclusion_reason: "x".repeat(201) },
	]) {
		const response = await request("PUT", patch);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "invalid_payload" } });
	}
	expect((await request("GET", undefined, reader)).status).toBe(200);
	expect((await request("PUT", { category: "app" }, reader)).status).toBe(403);
	expect((await request("GET", undefined, wrong)).status).toBe(403);
	expect((await request("PUT", { category: "app" }, wrong)).status).toBe(403);
	expect((await request("GET", undefined, "invalid")).status).toBe(401);
	expect((await request("GET", undefined, bearer, repository, "z".repeat(21))).status).toBe(403);
	expect((await request("GET", undefined, bearer, repository, account, "?x=1")).status).toBe(400);
	expect((await request("GET", undefined, bearer, `${owner}/missing`)).status).toBe(404);
	for (const [identity, name] of [
		["R_agent", `${owner}/agent`],
		["R_owner", "agent/app"],
	] as const) {
		marker();
		rows(
			`INSERT INTO catalog_repositories(account_id,identity_key,github_id,repo,row_payload,is_archived,visibility,is_fork,first_seen_source) VALUES(${quote(account)},${quote(identity)},${quote(identity)},${quote(name)},'{}',0,'PUBLIC',0,'github_catalog');`,
		);
		expect((await request("GET", undefined, bearer, name)).status).toBe(200);
		expect((await request("PUT", { category: "app" }, wrong, name)).status).toBe(403);
		expect((await request("PUT", { category: "app" }, bearer, name)).status).toBe(200);
	}
});

it("R6 HTTP browser reads retained renamed metadata and GET never changes rows or upstream call counts", async () => {
	marker();
	const prior = rows("SELECT id FROM accounts WHERE is_active=1")[0]?.id;
	const renamed = `${owner}/renamed`;
	rows(
		`UPDATE accounts SET is_active=0 WHERE is_active=1; UPDATE accounts SET is_active=1 WHERE id=${quote(account)}; UPDATE catalog_repositories SET repo=${quote(renamed)},removed_at='2026-10-23T00:00:00.000Z' WHERE account_id=${quote(account)} AND identity_key='R_app';`,
	);
	try {
		const before = rows(
			`SELECT * FROM repo_meta WHERE account_id=${quote(account)} ORDER BY identity_key; SELECT * FROM api_tokens WHERE account_id=${quote(account)} ORDER BY id;`,
		);
		const upstream = await (await fetch("http://127.0.0.1:17046/_count")).text();
		const jwt = process.env.GIRAFFE_JWT;
		const headers = jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {};
		const browser = await fetch(`${base}/api/repos/${renamed}/meta`, { headers });
		expect(browser.status).toBe(200);
		expect(browser.headers.get("cache-control")).toBe("private, no-store");
		expect(await browser.json()).toMatchObject({
			account_id: account,
			repo: renamed,
			repo_removed: true,
			deleted_at: "2026-10-23T00:00:00.000Z",
			category: "docs-vault",
		});
		expect((await request("GET", undefined, bearer, renamed)).status).toBe(200);
		expect(
			rows(
				`SELECT * FROM repo_meta WHERE account_id=${quote(account)} ORDER BY identity_key; SELECT * FROM api_tokens WHERE account_id=${quote(account)} ORDER BY id;`,
			),
		).toEqual(before);
		expect(await (await fetch("http://127.0.0.1:17046/_count")).text()).toBe(upstream);
		expect(
			(
				await fetch(`${base}/api/repos/${renamed}/meta`, {
					method: "PUT",
					headers: {
						...headers,
						origin: "https://giraffe.dev.hexly.ai",
						"content-type": "application/json",
					},
					body: '{"category":"app"}',
				})
			).status,
		).toBe(405);
		expect((await request("PUT", { category: "repro" }, bearer, renamed)).status).toBe(200);
		expect(
			((await (await request("GET", undefined, bearer, renamed)).json()) as RepoMeta).category,
		).toBe("repro");
	} finally {
		marker();
		rows(
			`UPDATE accounts SET is_active=0 WHERE id=${quote(account)};${typeof prior === "string" ? `UPDATE accounts SET is_active=1 WHERE id=${quote(prior)};` : ""}`,
		);
	}
});
