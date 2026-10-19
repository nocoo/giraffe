import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";
import { createApiToken } from "../lib/api-tokens";
import { createDb } from "../lib/db/d1";

async function setup() {
	const raw = sqliteFixture();
	const accountId = "a".repeat(21);
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake','t','t')",
		)
		.bind(accountId)
		.run();
	const token = await createApiToken(createDb(raw), {
		accountId,
		label: "External bot",
		scopes: ["observations:read", "agent:read", "agent:write", "app:read", "app:write"],
		creator: "fixture@local",
	});
	const verifier = "x".repeat(43);
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const code = `giraffe_code_${"h".repeat(43)}`;
	const redirectUri = "http://localhost:23456/callback";
	for (const [hash, expiresAt] of [
		[createHash("sha256").update(code).digest("hex"), "2050-01-01T00:00:00Z"],
		["e".repeat(64), "2020-01-02T00:00:00Z"],
	])
		await raw
			.prepare(
				"INSERT INTO api_authorization_codes(code_hash,account_id,label,scopes,creator,expires_in_days,redirect_uri,code_challenge,created_at,expires_at) VALUES(?,?,?,'[\"agent:read\"]','fixture@local',30,?,?,'2020-01-01T00:00:00Z',?)",
			)
			.bind(hash, accountId, "Historical consent", redirectUri, challenge, expiresAt)
			.run();
	const app = createApp();
	const env = { DB: raw, ENVIRONMENT: "development", GITHUB_API_BASE: "http://fixture" } as Env;
	const snapshot = async () => ({
		codes: (await raw.prepare("SELECT * FROM api_authorization_codes ORDER BY code_hash").all())
			.results,
		tokens: (await raw.prepare("SELECT * FROM api_tokens ORDER BY id").all()).results,
		changes: await raw.prepare("SELECT total_changes() AS count").first(),
	});
	return { app, env, token, snapshot, accountId, verifier, challenge, code, redirectUri };
}

it("retires CLI consent without writing codes or tokens and preserves browser auth boundaries", async () => {
	const fixture = await setup();
	const before = await fixture.snapshot();
	const body = {
		account_id: fixture.accountId,
		label: "Retired CLI",
		scopes: ["agent:read"],
		expires_in_days: 30,
		redirect_uri: fixture.redirectUri,
		state: "opaque-state",
		code_challenge: fixture.challenge,
		code_challenge_method: "S256",
		consent: true,
	};
	for (const method of ["POST", "GET", "PUT", "PATCH", "DELETE"]) {
		const response = await fixture.app.request(
			"http://localhost/api/cli/authorize",
			{
				method,
				headers: { origin: "https://giraffe.dev.hexly.ai", "content-type": "application/json" },
				...(method === "GET" ? {} : { body: JSON.stringify(body) }),
			},
			fixture.env,
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: { code: "not_found", message: "not found" } });
	}
	expect(
		(
			await fixture.app.request(
				"http://localhost/api/cli/authorize",
				{ method: "POST", headers: { origin: "https://evil.test" } },
				fixture.env,
			)
		).status,
	).toBe(403);
	expect(
		(
			await fixture.app.request(
				"http://localhost/api/cli/authorize",
				{ method: "POST" },
				{ ...fixture.env, ENVIRONMENT: "production" },
			)
		).status,
	).toBe(401);
	expect(await fixture.snapshot()).toEqual(before);
});

it("removes the tokenless exchange exception and leaves historical grants untouched", async () => {
	const fixture = await setup();
	const before = await fixture.snapshot();
	const body = {
		code: fixture.code,
		code_verifier: fixture.verifier,
		redirect_uri: fixture.redirectUri,
	};
	for (const method of ["POST", "GET", "PUT", "PATCH", "DELETE"]) {
		const response = await fixture.app.request(
			"http://localhost/api/v1/auth/exchange",
			{
				method,
				headers: { "content-type": "application/json" },
				...(method === "GET" ? {} : { body: JSON.stringify(body) }),
			},
			fixture.env,
		);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ error: { code: "token_unauthorized" } });
	}
	for (const [method, status] of [
		["GET", 404],
		["POST", 405],
	] as const) {
		const response = await fixture.app.request(
			"http://localhost/api/v1/auth/exchange",
			{
				method,
				headers: {
					Authorization: `Bearer ${fixture.token.token}`,
					"content-type": "application/json",
				},
				...(method === "GET" ? {} : { body: JSON.stringify(body) }),
			},
			fixture.env,
		);
		expect(response.status).toBe(status);
		expect(await response.text()).not.toMatch(/giraffe_|redirect_uri|code_verifier/);
	}
	expect(await fixture.snapshot()).toEqual(before);
});
