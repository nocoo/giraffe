import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";

const id = "a".repeat(21);
it("keeps token CRUD and explicit PKCE consent behind Access and Origin", async () => {
	const raw = sqliteFixture();
	for (const sql of readFileSync("migrations/0011_api_access.sql", "utf8")
		.split(";")
		.filter((s) => s.trim()))
		await raw.prepare(sql).run();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake','t','t')",
		)
		.bind(id)
		.run();
	const app = createApp();
	const env = { DB: raw, ENVIRONMENT: "development", GITHUB_API_BASE: "http://fixture" } as Env;
	const call = (
		path: string,
		method = "GET",
		body?: unknown,
		origin = "https://giraffe.dev.hexly.ai",
	) =>
		app.request(
			`http://localhost/api/${path}`,
			{
				method,
				headers: { origin, "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
			env,
		);
	expect((await call("tokens")).status).toBe(400);
	expect((await call(`tokens?account_id=${"b".repeat(21)}`)).status).toBe(404);
	const created = await call("tokens", "POST", {
		account_id: id,
		label: "CLI",
		scopes: ["agent:read", "agent:write"],
		expires_in_days: 1,
	});
	expect(created.status).toBe(201);
	const token = (await created.json()) as { id: string; token: string };
	expect(token.token).toMatch(/^giraffe_/);
	const listed = (await (await call(`tokens?account_id=${id}`)).json()) as {
		items: Record<string, unknown>[];
	};
	expect(listed.items).toHaveLength(1);
	expect(listed.items[0]).not.toHaveProperty("token");
	expect(listed.items[0]).not.toHaveProperty("token_hash");
	expect(
		(
			await call(`tokens/${token.id}`, "PATCH", {
				account_id: id,
				label: "renamed",
				scopes: ["agent:read"],
			})
		).status,
	).toBe(200);
	expect(
		(await call(`tokens/${token.id}`, "PATCH", { account_id: id, scopes: ["app:write"] })).status,
	).toBe(403);
	expect(
		(
			await call(
				`tokens/${token.id}`,
				"PATCH",
				{ account_id: id, label: "no" },
				"https://evil.test",
			)
		).status,
	).toBe(403);
	expect((await call("tokens", "POST", [])).status).toBe(400);
	expect((await call("tokens", "POST", { account_id: id })).status).toBe(400);
	expect((await call(`tokens/${token.id}`, "DELETE", { account_id: id, extra: 1 })).status).toBe(
		400,
	);
	expect((await call(`tokens/${token.id}`, "DELETE", { account_id: id })).status).toBe(204);
	expect((await call(`v1/me`, "GET", undefined)).status).toBe(401);
	const verifier = "v".repeat(43);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
	const body = {
		account_id: id,
		label: "Browser consent",
		scopes: ["agent:read"],
		redirect_uri: "http://127.0.0.1:12345/callback",
		state: "opaque",
		code_challenge: challenge,
		code_challenge_method: "S256",
		consent: true,
	};
	expect((await call("cli/authorize", "POST", { ...body, consent: false })).status).toBe(400);
	expect((await call("cli/authorize", "POST", body, "https://evil.test")).status).toBe(403);
	const consent = await call("cli/authorize", "POST", body);
	expect(consent.status).toBe(200);
	const redirect = new URL(((await consent.json()) as { redirect_uri: string }).redirect_uri);
	expect([...redirect.searchParams.keys()].sort()).toEqual(["code", "state"]);
	expect(redirect.searchParams.get("state")).toBe("opaque");
	const exchange = {
		code: redirect.searchParams.get("code"),
		code_verifier: verifier,
		redirect_uri: body.redirect_uri,
	};
	const response = await call("v1/auth/exchange", "POST", exchange);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ account_id: id, scopes: ["agent:read"] });
	expect((await call("v1/auth/exchange", "POST", exchange)).status).toBe(400);
});
