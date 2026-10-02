import { expect, it } from "vitest";
import { GiraffeClient } from "../../../../../packages/agent/src/client";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";
import { createApiToken } from "../lib/api-tokens";
import { createDb } from "../lib/db/d1";

it("uses the actual local Agent client against Worker CRUD with SQLite transactions", async () => {
	const DB = sqliteFixture();
	const id = "a".repeat(21);
	await DB.prepare(
		"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake','t','t')",
	)
		.bind(id)
		.run();
	const token = await createApiToken(createDb(DB), {
		accountId: id,
		label: "local integration",
		scopes: ["agent:read", "agent:write"],
		expiresInDays: 1,
		creator: "fixture@local",
	});
	const env = { DB, ENVIRONMENT: "production" } as Env;
	const app = createApp();
	const transport = Object.assign(
		async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
			app.request(String(input), init, env),
		{ preconnect: () => {} },
	);
	const client = new GiraffeClient(
		{
			baseUrl: "https://giraffe.hexly.ai",
			token: token.token,
			account_id: id,
			expires_at: token.expires_at,
			scopes: token.scopes,
		},
		transport,
	);
	expect(await client.me()).toMatchObject({ account_id: id, login: "nocoo" });
	const created = await client.create("reports", {
		id: "same-id",
		repository: "nocoo/app",
		type: "github-analysis",
		status: "pending",
		source_version: "v1",
		payload: { local: true },
	});
	expect(created.revision).toBe(1);
	expect(await client.get("reports", "same-id")).toEqual(created);
	expect(await client.list("reports", { type: "github-analysis" })).toEqual([created]);
	expect(
		await client.create("reports", {
			id: "same-id",
			repository: "nocoo/app",
			type: "github-analysis",
			status: "pending",
			source_version: "v1",
			payload: { local: true },
		}),
	).toEqual(created);
	const changed = await client.update("reports", created, { status: "completed" });
	expect(changed.revision).toBe(2);
	await expect(client.update("reports", created, { status: "failed" })).rejects.toMatchObject({
		status: 409,
		code: "revision_conflict",
	});
	await client.remove("reports", changed);
	expect(await client.get("reports", "same-id")).toBeNull();
	expect(await client.list("reports")).toEqual([]);
});
