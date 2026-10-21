import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { factoryFixture } from "../fixtures/factory-snapshot";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const account = randomUUID().replaceAll("-", "").slice(0, 21);
const token = `giraffe_${randomBytes(32).toString("base64url")}`;
const restricted = `giraffe_${randomBytes(32).toString("base64url")}`;
const at = "2026-10-21T00:00:00.000Z";
const unknown = { mergeable: null, mergeStateStatus: null, checks: { state: null } };
const known = { mergeable: false, mergeStateStatus: "BLOCKED", checks: { state: "FAILURE" } };
const paths = ["prs", "repos/nocoo/app/prs", "factory/repos/nocoo/app/prs"];
let seeded = false;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

function sql(command: string): Record<string, unknown>[] {
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
		(row) => row.results,
	);
}

function marker() {
	expect(sql("SELECT value FROM _test_marker WHERE key='env'")).toEqual([{ value: "test" }]);
}

function snapshot(kind: string, data: unknown) {
	return `INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES(${quote(account)},${quote(kind)},${quote(JSON.stringify(data))},${quote(at)});`;
}

beforeAll(() => {
	marker();
	const publication = factoryFixture();
	const repo = publication.repos[0];
	if (!repo) throw new Error("missing repository fixture");
	publication.account_id = account;
	publication.runId = `pr-${account}`;
	repo.name = "nocoo/app";
	delete repo.observation;
	const list = [
		{ number: 1, name_with_owner: repo.name },
		{ number: 2, name_with_owner: repo.name, state: "open", ...known },
		{ number: 3, name_with_owner: repo.name, state: "closed" },
		{ number: 4, name_with_owner: repo.name, state: "closed", merged_at: at },
	];
	const now = new Date().toISOString();
	seeded = true;
	sql(
		[
			`INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(${quote(account)},${quote(`pr-${account}`)},'test-only-unused','fake',${quote(now)},${quote(now)});`,
			...[token, restricted].map(
				(bearer, index) =>
					`INSERT INTO api_tokens(id,account_id,token_hash,label,scopes,creator,created_at,expires_at) VALUES(${quote(`${account}-${index}`)},${quote(account)},${quote(createHash("sha256").update(bearer).digest("hex"))},'PR acceptance',${quote(JSON.stringify([index ? "app:read" : "observations:read"]))},'local test',${quote(now)},${quote(new Date(Date.now() + 86400_000).toISOString())});`,
			),
			snapshot("repos", { repos: [{ name_with_owner: repo.name }], fetched_at: at }),
			snapshot("prs", { pull_requests: list, fetched_at: at }),
			snapshot("repo:nocoo/app:prs", { pull_requests: list, fetched_at: at }),
			snapshot("factory", publication),
			snapshot("factory:nocoo/app:prs", {
				runId: publication.runId,
				items: list,
				next: null,
				ranges: [],
				coverage: { ...repo.coverage.prs, status: "complete", fetchedAt: at },
			}),
		].join("\n"),
	);
});

afterAll(() => {
	if (!seeded) return;
	marker();
	sql(`DELETE FROM accounts WHERE id=${quote(account)};`);
});

function get(path: string, bearer = token, selected = account) {
	return fetch(`${base}/api/v1/accounts/${selected}/${path}`, {
		headers: { authorization: `Bearer ${bearer}` },
	});
}

it("returns consistent known and legacy PR state on all three read-only endpoints", async () => {
	const stored = () =>
		sql(
			`SELECT * FROM snapshots WHERE account_id=${quote(account)} ORDER BY kind; SELECT * FROM api_tokens WHERE account_id=${quote(account)} ORDER BY id;`,
		);
	const calls = await (await fetch("http://127.0.0.1:17046/_count")).text();
	const before = stored();
	for (const path of paths) {
		const response = await get(path);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: Record<string, unknown>; fetchedAt: string };
		expect(body.fetchedAt).toBe(at);
		expect(body.data[path.startsWith("factory") ? "items" : "pull_requests"]).toMatchObject([
			{ number: 1, state: null, ...unknown },
			{ number: 2, state: "open", ...known },
			{ number: 3, state: "closed", ...unknown },
			{ number: 4, state: "merged", ...unknown },
		]);
	}
	expect(await (await fetch("http://127.0.0.1:17046/_count")).text()).toBe(calls);
	expect(stored()).toEqual(before);
});

it("enforces auth, scope, account and strict query boundaries for all PR endpoints", async () => {
	for (const path of paths) {
		expect((await get(path, "invalid")).status).toBe(401);
		expect((await get(path, restricted)).status).toBe(403);
		expect((await get(path, token, "outside")).status).toBe(403);
		const invalid = await get(`${path}?unexpected=1`);
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toMatchObject({ error: { code: "validation_failed" } });
	}
	expect((await get("repos/nocoo/missing/prs")).status).toBe(404);
	expect((await get("factory/repos/nocoo/missing/prs")).status).toBe(404);
});
