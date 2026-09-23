import { expect, it } from "vitest";
import { sqliteFixture } from "../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";

it("serves only the active account's repository assessment without upstream calls", async () => {
	const DB = sqliteFixture();
	const env = {
		DB,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://127.0.0.1:17046",
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
		FACTORY_QUEUE: {} as Queue,
		ASSETS: { fetch: async () => new Response() } as unknown as Fetcher,
	} satisfies Env;
	const request = (path: string, method = "GET") =>
		createApp().request(
			`http://localhost/api/${path}`,
			{ method, headers: { origin: "https://giraffe.dev.hexly.ai" } },
			env,
		);
	expect((await request("repos/nocoo/app/assessment")).status).toBe(409);
	await DB.prepare(
		"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES('account','nocoo','encrypted','fake',1,'2026','2026')",
	).run();
	expect((await request("repos/nocoo/app/assessment")).status).toBe(404);
	await DB.prepare("INSERT INTO snapshots VALUES('account','repos',?, '2026')")
		.bind(JSON.stringify({ repos: [{ name_with_owner: "nocoo/app" }] }))
		.run();
	const response = await request("repos/NOCOO/APP/assessment");
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toContain("no-store");
	expect(await response.json()).toMatchObject({
		account_id: "account",
		repo: "nocoo/app",
		status: "unconfigured",
		report: null,
	});
	expect((await request("repos/nocoo/app/assessment", "DELETE")).status).toBe(405);
	expect((await request("ai/settings")).status).toBe(200);
	expect((await request("ai/settings/judgment", "PUT")).status).toBe(405);
});
