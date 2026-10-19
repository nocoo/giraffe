import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";

const id = "a".repeat(21);
it("keeps browser token CRUD behind Access and Origin", async () => {
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
	expect((await call("tokens/missing", "PATCH", { account_id: id, label: "missing" })).status).toBe(
		404,
	);
	const created = await call("tokens", "POST", {
		account_id: id,
		label: "External bot",
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
});
