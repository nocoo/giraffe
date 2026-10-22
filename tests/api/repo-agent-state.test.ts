import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { RepoAgentState } from "../../apps/web/src/lib/repo-agent-state";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const account = randomUUID().replaceAll("-", "").slice(0, 21);
const owner = `state-${account}`;
const repository = `${owner}/app`;
const bearer = `giraffe_${randomBytes(32).toString("base64url")}`;
const wrongScope = `giraffe_${randomBytes(32).toString("base64url")}`;
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
	headers: Record<string, string> = {},
	name = repository,
	selected = account,
	query = "",
) =>
	fetch(`${base}/api/v1/accounts/${selected}/repos/${name}/agent-state${query}`, {
		method,
		headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...headers },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
beforeAll(() => {
	marker();
	const now = new Date().toISOString();
	const mint = (token: string, scopes: string[], suffix: string) =>
		`INSERT INTO api_tokens(id,account_id,token_hash,label,scopes,creator,created_at,expires_at) VALUES(${quote(`${account}-${suffix}`)},${quote(account)},${quote(createHash("sha256").update(token).digest("hex"))},'agent-state L2',${quote(JSON.stringify(scopes))},'local test',${quote(now)},${quote(new Date(Date.now() + 86400_000).toISOString())});`;
	seeded = true;
	rows(
		[
			`INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(${quote(account)},${quote(owner)},'test-not-an-encrypted-pat','fake',${quote(now)},${quote(now)});`,
			mint(bearer, ["app:read", "app:write", "observations:read"], "reader"),
			mint(wrongScope, ["observations:read", "agent:read", "agent:write"], "wrong"),
			`INSERT INTO catalog_repositories(account_id,identity_key,github_id,repo,row_payload,first_seen_at,last_seen_at,is_archived,visibility,is_fork,first_seen_source) VALUES(${quote(account)},'R_app','R_app',${quote(repository)},${quote(JSON.stringify({ name_with_owner: repository }))},${quote(now)},${quote(now)},0,'PUBLIC',0,'github_catalog');`,
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

it("R5 HTTP creates, reads, updates with header precedence and rejects optimistic races or missing/stale revisions", async () => {
	const empty = await request();
	expect(empty.status).toBe(200);
	expect(empty.headers.get("etag")).toBe('"0"');
	expect(await empty.json()).toMatchObject({ payload: null, revision: null });
	const created = await request("PUT", {
		payload: { summary: "reviewed", status: "attention", memory: { arbitrary: [null, 1] } },
	});
	expect(created.status).toBe(200);
	expect(await created.json()).toMatchObject({ revision: 1, updated_by: `${account}-reader` });
	expect((await request("PUT", { payload: {} })).status).toBe(428);
	expect((await request("PUT", { revision: 2, payload: {} })).status).toBe(409);
	expect(
		(
			await request(
				"PUT",
				{ revision: 99, payload: { summary: "reviewed", status: "ok" } },
				{ "if-match": '"1"' },
			)
		).status,
	).toBe(200);
	const race = await Promise.all(
		["left", "right"].map((summary) =>
			request("PUT", { revision: 2, payload: { summary, status: "ok" } }),
		),
	);
	expect(race.map((response) => response.status).sort()).toEqual([200, 409]);
	expect(((await (await request()).json()) as RepoAgentState).revision).toBe(3);
});

it("R5 HTTP validates Unicode bytes, strict queries/scopes/account isolation and unsupported preconditions", async () => {
	const payload = { x: `${"界".repeat(5458)}xx` };
	expect(Buffer.byteLength(JSON.stringify(payload))).toBe(16384);
	expect((await request("PUT", { revision: 3, payload })).status).toBe(200);
	const tooLarge = await request("PUT", { revision: 4, payload: { x: `${payload.x}x` } });
	expect(tooLarge.status).toBe(400);
	expect(await tooLarge.json()).toMatchObject({ error: { code: "payload_too_large" } });
	for (const body of [{ payload: null }, { payload: [] }, { payload: {}, unknown: true }]) {
		const response = await request("PUT", body);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "invalid_payload" } });
	}
	for (const header of ["*", 'W/"4"', '"0"', "4"])
		expect((await request("PUT", { payload: {} }, { "if-match": header })).status).toBe(400);
	expect((await request("GET", undefined, { authorization: `Bearer ${wrongScope}` })).status).toBe(
		403,
	);
	expect(
		(await request("PUT", { payload: {} }, { authorization: `Bearer ${wrongScope}` })).status,
	).toBe(403);
	expect((await request("GET", undefined, { authorization: "Bearer invalid" })).status).toBe(401);
	expect((await request("GET", undefined, {}, repository, "z".repeat(21))).status).toBe(403);
	expect((await request("GET", undefined, {}, repository, account, "?x=1")).status).toBe(400);
	expect((await request("GET", undefined, {}, `${owner}/missing`)).status).toBe(404);
});

it("R5 HTTP browser reads active-account state and renamed/removed state stays writable without false 304 or GET writes", async () => {
	marker();
	const prior = rows("SELECT id FROM accounts WHERE is_active=1")[0]?.id;
	rows(
		`UPDATE accounts SET is_active=0 WHERE is_active=1; UPDATE accounts SET is_active=1 WHERE id=${quote(account)}; UPDATE catalog_repositories SET repo=${quote(`${owner}/renamed`)},removed_at='2026-10-23T00:00:00.000Z' WHERE account_id=${quote(account)} AND identity_key='R_app';`,
	);
	try {
		const before = rows(
			`SELECT * FROM repo_agent_state WHERE account_id=${quote(account)}; SELECT * FROM api_tokens WHERE account_id=${quote(account)} ORDER BY id;`,
		);
		const calls = await (await fetch("http://127.0.0.1:17046/_count")).text();
		const jwt = process.env.GIRAFFE_JWT;
		const response = await fetch(`${base}/api/repos/${owner}/renamed/agent-state`, {
			headers: { ...(jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {}), "if-none-match": '"4"' },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("etag")).toBe('"4"');
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toMatchObject({
			account_id: account,
			repo: `${owner}/renamed`,
			repo_removed: true,
			revision: 4,
		});
		expect(
			rows(
				`SELECT * FROM repo_agent_state WHERE account_id=${quote(account)}; SELECT * FROM api_tokens WHERE account_id=${quote(account)} ORDER BY id;`,
			),
		).toEqual(before);
		expect(await (await fetch("http://127.0.0.1:17046/_count")).text()).toBe(calls);
		expect(
			(
				await request(
					"PUT",
					{ revision: 4, payload: { summary: "retained", status: "blocked" } },
					{},
					`${owner}/renamed`,
				)
			).status,
		).toBe(200);
		expect((await request()).status).toBe(404);
	} finally {
		marker();
		rows(
			`UPDATE accounts SET is_active=0 WHERE id=${quote(account)};${typeof prior === "string" ? `UPDATE accounts SET is_active=1 WHERE id=${quote(prior)};` : ""}`,
		);
	}
});

it("R5 HTTP protects special-name scopes, identity-safe revisions and opaque JSON validation", async () => {
	marker();
	const seed = (identity: string, name: string) =>
		rows(
			`INSERT INTO catalog_repositories(account_id,identity_key,github_id,repo,row_payload,is_archived,visibility,is_fork,first_seen_source) VALUES(${quote(account)},${quote(identity)},${quote(identity)},${quote(name)},'{}',0,'PUBLIC',0,'github_catalog');`,
		);
	for (const [identity, name] of [
		["R_agent", `${owner}/agent`],
		["R_owner", "agent/app"],
	] as const) {
		seed(identity, name);
		for (const method of ["GET", "PUT"])
			expect(
				(
					await request(
						method,
						method === "PUT" ? { payload: { summary: "forbidden" } } : undefined,
						{ authorization: `Bearer ${wrongScope}` },
						name,
					)
				).status,
			).toBe(403);
		expect((await request("GET", undefined, {}, name)).status).toBe(200);
		const payload = JSON.parse('{"summary":"original","__proto__":{"value":"opaque"}}');
		const created = await request("PUT", { payload }, {}, name);
		expect(created.status).toBe(200);
		const original = (await created.json()) as RepoAgentState;
		expect(JSON.stringify(original.payload)).toBe(JSON.stringify(payload));
		const oversized = JSON.parse(`{"__proto__":{"value":"${"x".repeat(17000)}"}}`);
		expect(
			(await request("PUT", { revision: original.revision, payload: oversized }, {}, name)).status,
		).toBe(400);
		const nested = JSON.parse(`${'{"nested":'.repeat(1001)}null${"}".repeat(1001)}`);
		expect(
			(await request("PUT", { revision: original.revision, payload: nested }, {}, name)).status,
		).toBe(400);
		rows(
			`UPDATE catalog_repositories SET removed_at='2026-10-22T06:00:00Z' WHERE account_id=${quote(account)} AND identity_key=${quote(identity)};`,
		);
		seed(`${identity}_new`, name);
		const fresh = await request("PUT", { payload: { summary: "replacement" } }, {}, name);
		expect(fresh.status).toBe(200);
		const replacement = (await fresh.json()) as RepoAgentState;
		expect(replacement.revision).not.toBe(original.revision);
		for (const header of [true, false])
			expect(
				(
					await request(
						"PUT",
						{ ...(header ? {} : { revision: original.revision }), payload: { summary: "stale" } },
						header ? { "if-match": `"${original.revision}"` } : {},
						name,
					)
				).status,
			).toBe(409);
		expect(
			((await (await request("GET", undefined, {}, name)).json()) as RepoAgentState).payload,
		).toEqual({ summary: "replacement" });
	}
});
