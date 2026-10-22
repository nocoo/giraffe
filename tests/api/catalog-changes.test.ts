import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { CatalogChanges } from "../../apps/web/src/lib/catalog-types";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const account = randomUUID().replaceAll("-", "").slice(0, 21);
const owner = `catalog-${account}`;
const bearer = `giraffe_${randomBytes(32).toString("base64url")}`;
const wrongScope = `giraffe_${randomBytes(32).toString("base64url")}`;
const floor = "2026-10-20T00:00:00.000Z";
const until = "2026-10-22T00:00:00.000Z";
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
		(result) => result.results,
	);
}

const marker = () =>
	expect(rows("SELECT value FROM _test_marker WHERE key='env'")).toEqual([{ value: "test" }]);
const request = (
	resource = `catalog/changes?since=${floor}`,
	token: string | null = bearer,
	method = "GET",
	tag?: string,
	selectedAccount = account,
) =>
	fetch(`${base}/api/v1/accounts/${selectedAccount}/${resource}`, {
		method,
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(tag ? { "If-None-Match": tag } : {}),
		},
	});

const repoRow = (name: string, archived = false) => ({
	name_with_owner: `${owner}/${name}`,
	name,
	owner_login: owner,
	description: "fixture",
	stargazer_count: 3,
	fork_count: 1,
	open_issue_count: 0,
	primary_language: "TypeScript",
	pushed_at: floor,
	visibility: "PUBLIC",
	is_private: false,
	is_archived: archived,
	is_fork: false,
	url: `https://github.com/${owner}/${name}`,
});

beforeAll(() => {
	marker();
	seeded = true;
	const now = new Date().toISOString();
	const mint = (token: string, scope: string, suffix: string) =>
		`INSERT INTO api_tokens(id,account_id,token_hash,label,scopes,creator,created_at,expires_at) VALUES(${quote(`${account}-${suffix}`)},${quote(account)},${quote(createHash("sha256").update(token).digest("hex"))},'catalog L2',${quote(JSON.stringify([scope]))},'local test',${quote(now)},${quote(new Date(Date.now() + 86400_000).toISOString())});`;
	const repository = (name: string, removed: boolean, archived = false) =>
		`INSERT INTO catalog_repositories(account_id,identity_key,github_id,repo,row_payload,first_seen_at,last_seen_at,removed_at,archived_changed_at,is_archived,visibility,is_fork,first_seen_source) VALUES(${quote(account)},${quote(name)},${quote(`R_${name}`)},${quote(`${owner}/${name}`)},${quote(JSON.stringify(repoRow(name, archived)))},${quote(floor)},${quote(removed ? floor : until)},${removed ? quote(until) : "NULL"},${archived ? quote(until) : "NULL"},${archived ? 1 : 0},'PUBLIC',0,'github_catalog');`;
	const event = (kind: string, name: string, details: Record<string, unknown> = {}) =>
		`INSERT INTO catalog_changes(account_id,event_id,kind,repo,github_id,at,source_kind,source_run_id,details) VALUES(${quote(account)},${quote(`${kind}-${name}`)},${quote(kind)},${quote(`${owner}/${name}`)},${quote(`R_${name}`)},${quote(until)},'factory','catalog-fixture',${quote(JSON.stringify(details))});`;
	rows(
		[
			`INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(${quote(account)},${quote(owner)},'test-not-an-encrypted-pat','fake',${quote(now)},${quote(now)});`,
			mint(bearer, "observations:read", "reader"),
			mint(wrongScope, "app:read", "management"),
			`INSERT INTO catalog_state(account_id,history_since,checked_at,revision,source_run_id) VALUES(${quote(account)},${quote(floor)},${quote(until)},1,'catalog-fixture');`,
			repository("live", false),
			repository("archive", false, true),
			repository("removed", true),
			event("added", "live"),
			event("added", "archive"),
			event("removed", "removed"),
			event("archived", "archive", { before: false, after: true }),
			event("renamed", "live", { previous_repo: `${owner}/old` }),
			`INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES(${quote(account)},'repos',${quote(JSON.stringify({ repos: [repoRow("live"), repoRow("archive", true)], fetched_at: until, truncated: false }))},${quote(until)});`,
			`INSERT INTO repo_stars(account_id,repo,starred,source,updated_at) VALUES(${quote(account)},${quote(`${owner}/live`)},1,'owner',${quote(floor)});`,
		].join("\n"),
	);
});

afterAll(() => {
	if (!seeded) return;
	marker();
	rows(`DELETE FROM accounts WHERE id=${quote(account)};`);
});

it("R7 HTTP returns ordered inclusive discovery events, conditional responses and no GET side effects", async () => {
	const saved = () =>
		rows(
			[
				"catalog_repositories",
				"catalog_changes",
				"catalog_state",
				"snapshots",
				"repo_stars",
				"api_tokens",
			]
				.map((table) => `SELECT * FROM ${table} WHERE account_id=${quote(account)} ORDER BY rowid;`)
				.join("\n"),
		);
	const before = saved();
	const calls = await (await fetch("http://127.0.0.1:17046/_count")).text();
	const response = await request(
		`catalog/changes?since=${encodeURIComponent("2026-10-22T08:00:00+08:00")}`,
	);
	expect(response.status).toBe(200);
	const changes = (await response.json()) as CatalogChanges;
	expect(changes).toMatchObject({
		account_id: account,
		since: until,
		until,
		history_since: floor,
		warning_code: null,
	});
	expect(changes.added.map((event) => event.repo)).toEqual([`${owner}/archive`, `${owner}/live`]);
	expect(changes.removed).toEqual([
		expect.objectContaining({
			repo: `${owner}/removed`,
			at: until,
			source: { kind: "factory", runId: "catalog-fixture" },
		}),
	]);
	expect(changes.archived[0]).toMatchObject({ before: false, after: true });
	expect(changes.renamed[0]).toMatchObject({ previous_repo: `${owner}/old`, github_id: "R_live" });
	expect(changes.unarchived).toEqual([]);
	expect(changes.visibility_changed).toEqual([]);
	expect(changes.fork_changed).toEqual([]);
	const tag = response.headers.get("etag");
	expect(tag).toMatch(/^"[a-f0-9]+"$/);
	const conditional = await request(`catalog/changes?since=${until}`, bearer, "GET", `W/${tag}`);
	expect(conditional.status).toBe(304);
	expect(await conditional.text()).toBe("");
	expect(conditional.headers.get("cache-control")).toBe("private, no-store");
	expect(conditional.headers.get("vary")).toBe("Authorization");
	expect(await (await fetch("http://127.0.0.1:17046/_count")).text()).toBe(calls);
	expect(saved()).toEqual(before);
});

it("R7 HTTP repository history distinguishes current, removed and starred membership", async () => {
	const catalog = async (query: string) => {
		const response = await request(`repos${query}`);
		expect(response.status).toBe(200);
		return ((await response.json()) as { data: { repos: Record<string, unknown>[] } }).data.repos;
	};
	const current = await catalog("?scope=all");
	expect(current.map((repo) => repo.name_with_owner).sort()).toEqual([
		`${owner}/archive`,
		`${owner}/live`,
	]);
	expect(current.find((repo) => repo.name === "live")).toMatchObject({
		...repoRow("live"),
		first_seen_at: floor,
		last_seen_at: until,
		removed_at: null,
		archived_changed_at: null,
		starred: true,
		star_source: "owner",
	});
	const departed = (await catalog("?include=removed")).find((repo) => repo.name === "removed");
	expect(departed).toMatchObject({ removed_at: until, last_seen_at: floor, starred: false });
	expect(
		(await catalog("?scope=starred&include=removed")).map((repo) => repo.name_with_owner),
	).toEqual([`${owner}/live`]);
	const sources = await request("sources");
	expect(sources.status).toBe(200);
	expect(await sources.json()).toMatchObject({
		repositories: [`${owner}/archive`, `${owner}/live`],
	});
	expect((await request(`sources?repository=${owner}%2Fremoved`)).status).toBe(404);
});

it("R7 HTTP rejects invalid history cursors, unauthorized conditions and expired history", async () => {
	for (const query of [
		"",
		"?since=",
		"?since=yesterday",
		"?since=2026-10-22",
		"?since=2026-02-30T00:00:00Z",
		"?since=2026-10-23T00:00:00Z",
		`?since=${floor}&since=${floor}`,
		`?since=${floor}&scope=all`,
	])
		expect((await request(`catalog/changes${query}`, bearer, "GET", "*")).status, query).toBe(400);
	const expired = await request("catalog/changes?since=2026-10-19T00:00:00Z");
	expect(expired.status).toBe(410);
	expect(await expired.json()).toMatchObject({ error: { code: "catalog_history_expired" } });
	for (const [token, status] of [
		[null, 401],
		["invalid", 401],
		[wrongScope, 403],
	] as const)
		expect((await request(undefined, token, "GET", "*")).status).toBe(status);
	expect((await request(undefined, bearer, "GET", "*", "z".repeat(21))).status).toBe(403);
	for (const method of ["POST", "PUT", "DELETE", "HEAD"])
		expect((await request(undefined, bearer, method)).status).toBe(405);
	for (const query of ["include=all", "include=removed&include=removed", "unknown=1"])
		expect((await request(`repos?${query}`)).status).toBe(400);
	marker();
	rows(`UPDATE catalog_state SET checked_at=NULL WHERE account_id=${quote(account)};`);
	try {
		const pending = await request();
		expect(pending.status).toBe(409);
		expect(await pending.json()).toMatchObject({ error: { code: "catalog_unpublished" } });
	} finally {
		marker();
		rows(`UPDATE catalog_state SET checked_at=${quote(until)} WHERE account_id=${quote(account)};`);
	}
});
