import { createHash } from "node:crypto";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { profileDb } from "../../../../../tests/fixtures/profile-db";
import { sourcesFixture } from "../../../../../tests/fixtures/sources";
import type { ApiScope } from "../../lib/api-access";
import type { Env } from "../env";
import { createApp } from "../index";
import { createApiToken } from "../lib/api-tokens";
import { createDb } from "../lib/db/d1";
import { SourceTiming } from "../lib/source-timing";

async function setup() {
	const fixture = await sourcesFixture();
	const { raw, account } = fixture;
	const mint = (scopes: ApiScope[], now?: string) =>
		createApiToken(
			createDb(raw),
			{
				accountId: account,
				label: "local conditional tests",
				scopes,
				expiresInDays: 1,
				creator: "fixture@local.test",
			},
			now,
		);
	const token = await mint(["observations:read"]);
	const app = createApp();
	const profile = profileDb(raw);
	const env = { DB: profile.raw, ENVIRONMENT: "development" } as unknown as Env;
	const path = `/api/v1/accounts/${account}/sources`;
	const call = (match?: string, bearer: string | null = token.token, suffix = "", method = "GET") =>
		app.request(
			`http://localhost${path}${suffix}`,
			{
				method,
				headers: {
					...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
					...(match ? { "If-None-Match": match } : {}),
				},
			},
			env,
		);
	return { ...fixture, mint, token, app, env, path, call, profile };
}

function requireTag(response: Response) {
	const tag = response.headers.get("etag");
	expect(tag).toEqual(expect.stringMatching(/^"[a-f0-9]{64}"$/));
	if (!tag) throw new Error("missing strong tag");
	return tag;
}

it("exposes safe request-local phase timings on sources 200 and 304 only", async () => {
	const fixture = await setup();
	const response = await fixture.call();
	expect(fixture.profile.trips.map((trip) => trip.statements)).toEqual([1, 5]);
	const tag = requireTag(response);
	for (const measured of [response, await fixture.call(tag)]) {
		const header = measured.headers.get("server-timing");
		expect(header).not.toBeNull();
		const metrics = (header ?? "").split(", ");
		for (const metric of metrics)
			expect(metric).toMatch(
				/^(auth|build|decode|hash|serialize|total|d1_\d+|sql_\d+);dur=\d+\.\d{2}$/,
			);
		for (const name of ["auth", "build", "decode", "hash", "serialize", "total", "d1_1"])
			expect(metrics.some((metric) => metric.startsWith(`${name};dur=`))).toBe(true);
		expect(metrics.filter((metric) => metric.startsWith("d1_"))).toHaveLength(2);
		expect(header).not.toContain(fixture.account);
		expect(header).not.toContain(fixture.token.token);
	}
	for (const bearer of [null, "invalid"])
		expect((await fixture.call(tag, bearer)).headers.has("server-timing")).toBe(false);
	const identity = await fixture.app.request(
		"http://localhost/api/v1/me",
		{
			headers: { Authorization: `Bearer ${fixture.token.token}` },
		},
		fixture.env,
	);
	expect(identity.headers.has("server-timing")).toBe(false);
});

it("measures source decoding and projection even with a coarsened worker clock", async () => {
	const fixture = await setup();
	const measure = vi.spyOn(SourceTiming.prototype, "measure");
	const measureAsync = vi.spyOn(SourceTiming.prototype, "measureAsync");
	const clock = vi.spyOn(performance, "now").mockReturnValue(0);
	try {
		const response = await fixture.call();
		expect(response.status).toBe(200);
		expect(measure.mock.calls.some(([phase]) => phase === "decode")).toBe(true);
		expect(measureAsync.mock.calls.filter(([phase]) => phase === "hash").length).toBeGreaterThan(1);
		expect(response.headers.get("server-timing")).toContain("decode;dur=0.00");
	} finally {
		measure.mockRestore();
		measureAsync.mockRestore();
		clock.mockRestore();
	}
});

it("conditionally returns large source responses with strong folded tags and retained private headers", async () => {
	const s = await setup();
	const snapshots = (await s.raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).results;
	const tokens = (await s.raw.prepare("SELECT * FROM api_tokens ORDER BY id").all()).results;
	const response = await s.call();
	expect(response.status).toBe(200);
	const tag = requireTag(response);
	const body = await response.text();
	expect(Buffer.byteLength(body)).toBeGreaterThan(262144);
	expect(tag).not.toBe(`"${createHash("sha256").update(body).digest("hex")}"`);
	for (const match of [tag, `W/${tag}`, `"unrelated", W/${tag}`, "*"]) {
		const conditional = await s.call(match);
		expect(conditional.status).toBe(304);
		expect(await conditional.text()).toBe("");
		expect(conditional.headers.get("etag")).toBe(tag);
		expect(conditional.headers.get("cache-control")).toBe("private, no-store");
		expect(conditional.headers.get("referrer-policy")).toBe("no-referrer");
		expect(conditional.headers.get("vary")).toBe("Authorization");
	}
	const unchanged = await s.call('"different"');
	expect(unchanged.status).toBe(200);
	expect(requireTag(unchanged)).toBe(tag);
	expect(await unchanged.text()).toBe(body);
	expect((await s.raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).results).toEqual(
		snapshots,
	);
	expect((await s.raw.prepare("SELECT * FROM api_tokens ORDER BY id").all()).results).toEqual(
		tokens,
	);
});

it("validates bearer, fixed account, scope, methods and filters before any 304", async () => {
	const s = await setup();
	const validTag = requireTag(await s.call());
	const expired = await s.mint(["observations:read"], "2025-01-01T00:00:00Z");
	const revoked = await s.mint(["observations:read"]);
	await s.raw
		.prepare("UPDATE api_tokens SET revoked_at='2026-01-01' WHERE id=?")
		.bind(revoked.id)
		.run();
	const wrongScope = await s.mint(["agent:read"]);
	for (const [bearer, status] of [
		[null, 401],
		["invalid", 401],
		[expired.token, 401],
		[revoked.token, 401],
		[wrongScope.token, 403],
	] as const) {
		for (const match of [validTag, "*"]) {
			s.profile.queries.length = 0;
			const response = await s.call(match, bearer);
			expect(response.status).toBe(status);
			expect(response.headers.has("etag")).toBe(false);
			expect(s.profile.queries.every((query) => query.sql.includes("FROM api_tokens"))).toBe(true);
		}
	}
	const other = await s.app.request(
		"http://localhost/api/v1/accounts/other/sources",
		{ headers: { Authorization: `Bearer ${s.token.token}`, "If-None-Match": "*" } },
		s.env,
	);
	expect(other.status).toBe(403);
	expect(other.headers.has("etag")).toBe(false);
	for (const suffix of ["?x=1", "?since=invalid", "?repository=invalid"]) {
		const response = await s.call("*", s.token.token, suffix);
		expect(response.status).toBe(400);
		expect(response.headers.has("etag")).toBe(false);
	}
	expect((await s.call("*", s.token.token, "?repository=outside%2Fcatalog")).status).toBe(404);
	for (const method of ["POST", "HEAD"])
		expect((await s.call("*", s.token.token, "", method)).status).toBe(405);
});

it("invalidates response variants and metadata without relying on source timestamps or versions alone", async () => {
	const s = await setup();
	const fullTag = requireTag(await s.call());
	const emptyTag = requireTag(
		await s.call(fullTag, s.token.token, "?since=2099-01-01T00%3A00%3A00Z"),
	);
	expect(emptyTag).not.toBe(fullTag);
	const selected = await s.call(fullTag, s.token.token, "?repository=FIXTURE%2FPROJECT-001");
	expect(selected.status).toBe(200);
	expect(requireTag(selected)).not.toBe(fullTag);
	s.snapshot.repos[0]?.coverage.dependencies &&
		s.snapshot.repos[0].coverage.dependencies.observed++;
	await s.raw
		.prepare("UPDATE snapshots SET payload=? WHERE account_id=? AND kind=?")
		.bind(JSON.stringify(s.snapshot), s.account, `factory:v:${s.snapshot.runId}`)
		.run();
	const changed = await s.call(fullTag);
	expect(changed.status).toBe(200);
	const changedTag = requireTag(changed);
	expect(changedTag).not.toBe(fullTag);
	expect((await s.call(emptyTag, s.token.token, "?since=2099-01-01T00%3A00%3A00Z")).status).toBe(
		304,
	);
	await s.raw
		.prepare(
			"UPDATE snapshots SET payload=json_set(payload,'$.issues[0].title','changed without timestamp') WHERE account_id=? AND kind='repo:fixture/project-001:issues'",
		)
		.bind(s.account)
		.run();
	const contentChanged = await s.call(changedTag);
	expect(contentChanged.status).toBe(200);
	const contentTag = requireTag(contentChanged);
	expect(contentTag).not.toBe(changedTag);
	await s.raw
		.prepare(
			"UPDATE snapshots SET payload=json_set(payload,'$.repos[0].description','changed catalog') WHERE account_id=? AND kind='repos'",
		)
		.bind(s.account)
		.run();
	const catalogChanged = await s.call(contentTag);
	expect(catalogChanged.status).toBe(200);
	expect(requireTag(catalogChanged)).not.toBe(contentTag);
});

it("appends authorization to inherited vary dimensions without adding manual compression", async () => {
	const s = await setup();
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.header("Vary", "Accept-Encoding");
		await next();
	});
	app.route("/", s.app);
	const request = (tag?: string) =>
		app.request(
			`http://localhost${s.path}`,
			{
				headers: {
					Authorization: `Bearer ${s.token.token}`,
					"Accept-Encoding": "gzip",
					...(tag ? { "If-None-Match": tag } : {}),
				},
			},
			s.env,
		);
	const response = await request();
	expect(response.headers.get("content-encoding")).toBeNull();
	expect(response.headers.get("vary")).toBe("Accept-Encoding, Authorization");
	const conditional = await request(requireTag(response));
	expect(conditional.status).toBe(304);
	expect(conditional.headers.get("vary")).toBe("Accept-Encoding, Authorization");
});
