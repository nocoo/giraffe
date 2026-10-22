import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { profileDb } from "../../../../../tests/fixtures/profile-db";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { ApiScope } from "../../lib/api-access";
import type { Env } from "../env";
import { createApp } from "../index";
import { createApiToken } from "../lib/api-tokens";
import { createDb } from "../lib/db/d1";

async function setup() {
	const raw = sqliteFixture();
	const db = createDb(raw);
	const snapshot = factoryFixture();
	const account = snapshot.account_id;
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake','old','old')",
		)
		.bind(account)
		.run();
	snapshot.runId = "new-publication";
	snapshot.window = { since: "2026-06-18T00:00:00.000Z", until: "2026-09-16T12:00:00.000Z" };
	snapshot.contribution = {
		days: [
			{ date: "2026-09-14", count: 9 },
			{ date: "2026-09-15", count: 3 },
		],
		total: 12,
		restricted: 2,
		fetchedAt: "2026-09-15T12:00:00.000Z",
	};
	snapshot.contributionStatus = "unavailable";
	snapshot.contributionObservation = {
		version: "retained-calendar",
		window: { since: "2026-06-18T00:00:00.000Z", until: "2026-09-15T12:00:00.000Z" },
		fetchedAt: snapshot.contribution.fetchedAt,
	};
	const save = () =>
		db
			.prepare(
				"INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES(?,'factory',?,?) ON CONFLICT(account_id,kind) DO UPDATE SET payload=excluded.payload",
			)
			.bind(account, JSON.stringify(snapshot), snapshot.fetched_at)
			.run();
	await save();
	const mint = (scopes: ApiScope[] = ["observations:read"], now?: string) =>
		createApiToken(
			db,
			{
				accountId: account,
				label: "local contribution tests",
				scopes,
				expiresInDays: 1,
				creator: "fixture@local.test",
			},
			now,
		);
	const token = await mint();
	const app = createApp();
	const env = { DB: raw, ENVIRONMENT: "development" } as unknown as Env;
	const path = `/api/v1/accounts/${account}/contributions`;
	const call = (query = "", bearer: string | null = token.token, match?: string, method = "GET") =>
		app.request(
			`http://localhost${path}${query}`,
			{
				method,
				headers: {
					...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
					...(match ? { "If-None-Match": match } : {}),
				},
			},
			env,
		);
	return { raw, db, snapshot, save, mint, token, app, env, path, call };
}

it("serves inclusive saved dates in an observation envelope and preserves retained source provenance", async () => {
	const s = await setup();
	const profile = profileDb(s.raw);
	s.env.DB = profile.raw;
	const saved = (await s.raw.prepare("SELECT * FROM snapshots").all()).results;
	const tokens = (await s.raw.prepare("SELECT * FROM api_tokens").all()).results;
	const response = await s.call("?since=2026-09-14&until=2026-09-15");
	expect(response.status).toBe(200);
	expect(profile.trips).toHaveLength(2);
	expect(await response.json()).toMatchObject({
		account_id: s.snapshot.account_id,
		sourceVersion: "retained-calendar",
		fetchedAt: "2026-09-15T12:00:00.000Z",
		freshness: {
			oldestAt: "2026-09-15T12:00:00.000Z",
			latestAt: "2026-09-15T12:00:00.000Z",
			total: 2,
			missing: 0,
		},
		unavailable: false,
		source: { kind: "factory", resource: "contributions", publicationId: "new-publication" },
		data: {
			since: "2026-09-14",
			until: "2026-09-15",
			total: 12,
			observedAt: "2026-09-15T12:00:00.000Z",
			timezone: "github",
			typeWindowTimezone: "UTC",
			partial: true,
			collectionStatus: "unavailable",
			days: [
				{
					date: "2026-09-14",
					count: 9,
					partial: false,
					types: { commits: null },
					breakdown: "unavailable",
				},
				{
					date: "2026-09-15",
					count: 3,
					partial: true,
					types: { restricted: null },
					breakdown: "unavailable",
				},
			],
		},
	});
	expect((await s.call("?since=2026-09-15&until=2026-09-15")).status).toBe(200);
	expect((await s.raw.prepare("SELECT * FROM snapshots").all()).results).toEqual(saved);
	expect((await s.raw.prepare("SELECT * FROM api_tokens").all()).results).toEqual(tokens);
});

it("validates strict dates, order, maximum saved range, duplicate and unknown query keys before conditional replies", async () => {
	const s = await setup();
	for (const query of [
		"?x=1",
		"?scope=all",
		"?since=2026-02-30",
		"?since=2026-9-14",
		"?until=2026-09-15T00:00:00Z",
		"?since=2026-09-15&until=2026-09-14",
		"?since=2026-01-01",
		"?until=2026-09-16",
		"?since=2026-09-14&since=2026-09-15",
		"?since=",
	]) {
		const response = await s.call(query, s.token.token, "*");
		expect(response.status, query).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
		expect(response.headers.has("etag")).toBe(false);
	}
});

it("authenticates bearer expiry, revocation, scope and fixed account before matching an ETag", async () => {
	const s = await setup();
	const expired = await s.mint(["observations:read"], "2025-01-01T00:00:00Z");
	const revoked = await s.mint();
	await s.db
		.prepare("UPDATE api_tokens SET revoked_at='2026-01-01' WHERE id=?")
		.bind(revoked.id)
		.run();
	const wrongScope = await s.mint(["agent:read"]);
	for (const [token, status] of [
		[null, 401],
		["invalid", 401],
		[expired.token, 401],
		[revoked.token, 401],
		[wrongScope.token, 403],
	] as const) {
		const response = await s.call("", token, "*");
		expect(response.status).toBe(status);
		expect(response.headers.has("etag")).toBe(false);
	}
	expect(
		(
			await s.app.request(
				"http://localhost/api/v1/accounts/other/contributions",
				{ headers: { Authorization: `Bearer ${s.token.token}`, "If-None-Match": "*" } },
				s.env,
			)
		).status,
	).toBe(403);
	expect((await s.call("", s.token.token, "*", "POST")).status).toBe(405);
	expect((await s.call("", s.token.token, "*", "HEAD")).status).toBe(405);
});

it("supports authenticated content ETags and preserves all private headers on 304", async () => {
	const s = await setup();
	const response = await s.call();
	expect(response.status).toBe(200);
	const tag = response.headers.get("etag");
	expect(tag).toMatch(/^"[a-f0-9]{64}"$/);
	const conditional = await s.call("", s.token.token, `"other", W/${tag}`);
	expect(conditional.status).toBe(304);
	expect(await conditional.text()).toBe("");
	expect(conditional.headers.get("cache-control")).toBe("private, no-store");
	expect(conditional.headers.get("vary")).toBe("Authorization");
	expect(conditional.headers.get("referrer-policy")).toBe("no-referrer");
	if (s.snapshot.contribution?.days[0]) s.snapshot.contribution.days[0].count = 10;
	await s.save();
	expect((await s.call("", s.token.token, tag ?? undefined)).status).toBe(200);
});

it("reports missing publications and calendars instead of empty success", async () => {
	const s = await setup();
	s.snapshot.contribution = null;
	await s.save();
	expect((await s.call()).status).toBe(409);
	await s.db.prepare("DELETE FROM snapshots").run();
	for (const query of [
		"?since=2026-09-15&until=2026-09-14",
		"?since=2026-01-01&until=2026-09-15",
		"?since=2026-02-30",
		"?unknown=1",
	]) {
		const invalid = await s.call(query, s.token.token, "*");
		expect(invalid.status, query).toBe(400);
		expect(await invalid.json()).toMatchObject({ error: { code: "validation_failed" } });
	}
	const response = await s.call();
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ error: { code: "snapshot_missing" } });
});

it("exposes missing days as unavailable null counts rather than inventing zero or a complete total", async () => {
	const s = await setup();
	s.snapshot.contribution?.days.push({ date: "2026-09-17", count: 2 });
	await s.save();
	const response = await s.call();
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		unavailable: true,
		freshness: { total: 4, missing: 1 },
		data: {
			total: null,
			days: [
				expect.anything(),
				expect.anything(),
				{ date: "2026-09-16", count: null, types: { commits: null }, unavailable: true },
				expect.anything(),
			],
		},
	});
});

it("preserves typed zeroes, per-day type observation times and original UTC cutoff on old publications", async () => {
	const s = await setup();
	if (!s.snapshot.contribution) throw new Error("fixture");
	s.snapshot.contribution.days = [
		{
			date: "2026-09-14",
			count: 0,
			observedAt: "2026-09-15T12:01:00.000Z",
			types: {
				commits: 0,
				issues: 0,
				pullRequests: 0,
				pullRequestReviews: 0,
				restricted: 0,
				repositories: 0,
			},
			breakdown: "complete",
			partial: false,
		},
	];
	s.snapshot.contribution.typesStatus = "complete";
	delete s.snapshot.contributionObservation;
	await s.save();
	const response = await s.call();
	expect(await response.json()).toMatchObject({
		sourceVersion: "new-publication",
		coverage: { status: "complete", typesStatus: "complete" },
		data: {
			total: 0,
			partial: false,
			window: s.snapshot.window,
			days: [
				{
					count: 0,
					types: { commits: 0, restricted: 0 },
					observedAt: "2026-09-15T12:01:00.000Z",
					breakdown: "complete",
				},
			],
		},
	});
});
