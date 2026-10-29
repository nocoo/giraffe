import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { executeD1FixtureSync } from "../fixtures/d1";
import { factoryFixture } from "../fixtures/factory-snapshot";
import { savedSnapshotSql } from "./saved-fixture";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const account = randomUUID().replaceAll("-", "").slice(0, 21);
const bearer = `giraffe_${randomBytes(32).toString("base64url")}`;
const wrongScope = `giraffe_${randomBytes(32).toString("base64url")}`;
const expired = `giraffe_${randomBytes(32).toString("base64url")}`;
const at = "2026-10-20T12:00:00.000Z";
const snapshot = factoryFixture();
const kind = "factory";
let seeded = false;

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
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
	const result = executeD1FixtureSync(command, { persist, config });
	return (JSON.parse(result) as { results: Record<string, unknown>[] }[]).flatMap(
		(result) => result.results,
	);
}
const marker = () =>
	expect(rows("SELECT value FROM _test_marker WHERE key='env'")).toEqual([{ value: "test" }]);
const save = () => rows(savedSnapshotSql(account, kind, { ...snapshot }, at));
const request = (
	query = "",
	token: string | null = bearer,
	tag?: string,
	method = "GET",
	selectedAccount = account,
) =>
	fetch(`${base}/api/v1/accounts/${selectedAccount}/contributions${query}`, {
		method,
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(tag ? { "If-None-Match": tag } : {}),
		},
	});

beforeAll(() => {
	marker();
	snapshot.account_id = account;
	snapshot.runId = `contributions-${account}`;
	snapshot.window = { since: "2026-10-19T00:00:00.000Z", until: at };
	snapshot.contributionStatus = "complete";
	snapshot.contribution = {
		total: 12,
		restricted: 1,
		fetchedAt: at,
		observedAt: at,
		timezone: "github",
		typeWindowTimezone: "UTC",
		typesStatus: "complete",
		partial: true,
		days: [
			{
				date: "2026-10-19",
				count: 9,
				partial: false,
				observedAt: at,
				types: {
					commits: 3,
					issues: 1,
					pullRequests: 2,
					pullRequestReviews: 1,
					restricted: 1,
					repositories: 1,
				},
				breakdown: "complete",
			},
			{
				date: "2026-10-20",
				count: 3,
				partial: true,
				observedAt: at,
				types: {
					commits: 2,
					issues: 0,
					pullRequests: 1,
					pullRequestReviews: 0,
					restricted: 0,
					repositories: 0,
				},
				breakdown: "complete",
			},
		],
	};
	snapshot.contributionObservation = {
		version: `calendar-${account}`,
		window: structuredClone(snapshot.window),
		fetchedAt: at,
	};
	const now = new Date().toISOString();
	const mint = (token: string, scopes: string[], suffix: string, expiresAt: string) =>
		`INSERT INTO api_tokens(id,account_id,token_hash,label,scopes,creator,created_at,expires_at) VALUES(${quote(`${account}-${suffix}`)},${quote(account)},${quote(createHash("sha256").update(token).digest("hex"))},'contributions L2',${quote(JSON.stringify(scopes))},'local test',${quote(suffix === "expired" ? "2024-12-31T00:00:00.000Z" : now)},${quote(expiresAt)});`;
	seeded = true;
	rows(
		[
			`INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(${quote(account)},${quote(`contributions-${account}`)},'test-not-an-encrypted-pat','fake',${quote(now)},${quote(now)});`,
			mint(bearer, ["observations:read"], "reader", new Date(Date.now() + 86400_000).toISOString()),
			mint(wrongScope, ["agent:read"], "agent", new Date(Date.now() + 86400_000).toISOString()),
			mint(expired, ["observations:read"], "expired", "2025-01-01T00:00:00.000Z"),
			savedSnapshotSql(account, kind, { ...snapshot }, at),
		].join("\n"),
	);
});

afterAll(() => {
	if (!seeded) return;
	marker();
	rows(`DELETE FROM accounts WHERE id=${quote(account)};`);
});

it("reads typed inclusive daily contributions and validates conditional polling without writes or upstream traffic", async () => {
	const saved = () =>
		rows(
			`SELECT kind,payload,fetched_at FROM refresh_snapshots WHERE account_id=${quote(account)} ORDER BY kind; SELECT * FROM api_tokens WHERE account_id=${quote(account)} ORDER BY id; SELECT * FROM refresh_publications WHERE account_id=${quote(account)};`,
		);
	const count = await (await fetch("http://127.0.0.1:17046/_count")).text();
	const before = saved();
	const response = await request("?since=2026-10-19&until=2026-10-20");
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		account_id: account,
		sourceVersion: `calendar-${account}`,
		fetchedAt: at,
		freshness: { oldestAt: at, latestAt: at, total: 2, missing: 0 },
		data: {
			total: 12,
			partial: true,
			observedAt: at,
			timezone: "github",
			typeWindowTimezone: "UTC",
			days: snapshot.contribution?.days,
		},
	});
	const tag = response.headers.get("etag");
	expect(tag).toMatch(/^"[a-f0-9]{64}"$/);
	const conditional = await request("?since=2026-10-19&until=2026-10-20", bearer, `W/${tag}`);
	expect(conditional.status).toBe(304);
	expect(await conditional.text()).toBe("");
	for (const [name, value] of [
		["cache-control", "private, no-store"],
		["vary", "Authorization"],
		["referrer-policy", "no-referrer"],
	])
		expect(conditional.headers.get(String(name))).toBe(value);
	const day = await request("?since=2026-10-20&until=2026-10-20");
	expect(await day.json()).toMatchObject({
		data: { total: 3, days: [snapshot.contribution?.days[1]] },
	});
	for (const query of [
		"?x=1",
		"?scope=starred",
		"?since=2026-02-30",
		"?since=2026-10-20&until=2026-10-19",
		"?since=2026-01-01",
		"?until=2026-10-21",
		"?since=2026-10-19&since=2026-10-20",
	]) {
		const invalid = await request(query, bearer, "*");
		expect(invalid.status, query).toBe(400);
		expect(await invalid.json()).toMatchObject({ error: { code: "validation_failed" } });
	}
	for (const [token, status] of [
		[null, 401],
		["invalid", 401],
		[expired, 401],
		[wrongScope, 403],
	] as const)
		expect((await request("", token, "*")).status).toBe(status);
	expect((await request("", bearer, "*", "GET", "z".repeat(21))).status).toBe(403);
	expect((await request("", bearer, "*", "POST")).status).toBe(405);
	expect((await request("", bearer, "*", "HEAD")).status).toBe(405);
	expect(
		(
			await fetch(`${base}/api/v1/accounts/${account}/contributions/unknown`, {
				headers: { Authorization: `Bearer ${bearer}` },
			})
		).status,
	).toBe(404);
	expect(await (await fetch("http://127.0.0.1:17046/_count")).text()).toBe(count);
	expect(saved()).toEqual(before);
});

it("retains calendar provenance on failed refresh and reports missing calendars without fabricated zeros", async () => {
	marker();
	snapshot.contributionStatus = "unavailable";
	snapshot.window.until = "2026-10-21T12:00:00.000Z";
	delete snapshot.contribution?.days[0]?.types;
	delete snapshot.contribution?.days[0]?.breakdown;
	save();
	const response = await request();
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		fetchedAt: at,
		sourceVersion: `calendar-${account}`,
		data: {
			collectionStatus: "unavailable",
			observedAt: at,
			days: [
				{
					date: "2026-10-19",
					count: 9,
					types: { commits: null, issues: null, restricted: null },
					breakdown: "unavailable",
				},
				expect.anything(),
			],
		},
	});
	snapshot.contribution = null;
	save();
	const missing = await request("", bearer, "*");
	expect(missing.status).toBe(409);
	expect(await missing.json()).toMatchObject({ error: { code: "snapshot_missing" } });
	expect(missing.headers.has("etag")).toBe(false);
});
