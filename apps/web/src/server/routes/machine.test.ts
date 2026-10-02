import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";
import { createApiToken } from "../lib/api-tokens";
import { createDb } from "../lib/db/d1";
import { replaceSnapshotStmts } from "../lib/db/snapshots";

const account = "a".repeat(21),
	other = "b".repeat(21);
async function setup() {
	const raw = sqliteFixture();
	for (const file of ["0011_api_access.sql", "0012_agent_resources.sql"])
		for (const sql of readFileSync(`migrations/${file}`, "utf8")
			.split(";")
			.filter((s) => s.trim()))
			await raw.prepare(sql).run();
	for (const id of [account, other])
		await raw
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?,?, 'fake','fake',?, 't','t')",
			)
			.bind(id, id === account ? "nocoo" : "other", Number(id === other))
			.run();
	const db = createDb(raw);
	await db.batch(
		replaceSnapshotStmts(
			db,
			account,
			"repos",
			{ repos: [{ name_with_owner: "nocoo/app", is_archived: true }] },
			"2026-10-02T00:00:00Z",
		),
	);
	const env = {
		DB: raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
		FACTORY_QUEUE: { send: vi.fn() },
	} as unknown as Env;
	const token = await createApiToken(db, {
		accountId: account,
		label: "test",
		scopes: ["observations:read", "agent:read", "agent:write", "app:read", "app:write"],
		expiresInDays: 1,
		creator: "test@local",
	});
	const app = createApp();
	const call = (
		path: string,
		method = "GET",
		body?: unknown,
		bearer: string | null = token.token,
	) =>
		app.request(
			`http://localhost/api/v1${path}`,
			{
				method,
				headers: {
					...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
					"content-type": "application/json",
				},
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			},
			env,
		);
	return { db, raw, env, app, token, call, prefix: `/accounts/${account}` };
}
it("enforces bearer, scopes and fixed account independently of dashboard activation", async () => {
	const s = await setup();
	expect((await s.call("/me", "GET", undefined, null)).status).toBe(401);
	expect((await s.call("/me", "GET", undefined, "bad")).status).toBe(401);
	const me = await s.call("/me");
	expect(await me.json()).toMatchObject({
		account_id: account,
		login: "nocoo",
		capabilities: { agentWrite: true },
	});
	expect((await s.call(`/accounts/${other}/repos`)).status).toBe(403);
	expect((await s.call(`${s.prefix}/repos`)).status).toBe(200);
	const readonly = await createApiToken(s.db, {
		accountId: account,
		label: "read",
		scopes: ["observations:read"],
		expiresInDays: 1,
		creator: "x",
	});
	expect(
		(
			await s.call(
				`${s.prefix}/agent/reports`,
				"POST",
				{ type: "analysis", status: "pending", payload: {} },
				readonly.token,
			)
		).status,
	).toBe(403);
	expect((await s.call(`${s.prefix}/repos`, "DELETE")).status).toBe(405);
	expect((await s.call(`${s.prefix}/missing`)).status).toBe(404);
	expect((await s.call(`${s.prefix}/repos/nocoo/app/nope`)).status).toBe(404);
	expect((await s.call(`${s.prefix}/repos/nocoo/missing`)).status).toBe(404);
	expect((await s.call(`${s.prefix}/repos/nocoo/app`)).status).toBe(409);
	expect((await s.call(`${s.prefix}/factory/repos/nocoo/app/commits`)).status).toBe(404);
	expect((await s.call("/auth/exchange")).status).toBe(405);
	expect((await s.call("/auth/exchange", "POST", {})).status).toBe(400);
	const prod = { ...s.env, ENVIRONMENT: "production" };
	expect((await s.app.request("http://localhost/api/repos", {}, prod)).status).toBe(401);
	expect((await s.app.request("http://localhost/api/tokens", {}, prod)).status).toBe(401);
});
it("performs all agent CRUD methods with validation and concurrency errors", async () => {
	const s = await setup();
	const path = `${s.prefix}/agent/reports`;
	const body = {
		id: "stable",
		type: "github-analysis",
		status: "pending",
		repository: "nocoo/app",
		source_version: "v1",
		payload: { domain: "prs" },
	};
	expect((await s.call(path, "POST", body)).status).toBe(201);
	expect((await s.call(path, "POST", body)).status).toBe(409);
	expect(await (await s.call(path)).json()).toMatchObject({
		account_id: account,
		items: [{ id: "stable", revision: 1 }],
	});
	expect((await s.call(`${path}/stable`)).status).toBe(200);
	expect((await s.call(`${path}/missing`)).status).toBe(404);
	expect(
		(await s.call(`${path}/stable`, "PATCH", { revision: 1, status: "completed" })).status,
	).toBe(200);
	expect((await s.call(`${path}/stable`, "PATCH", { revision: 1, status: "failed" })).status).toBe(
		409,
	);
	expect((await s.call(`${path}/stable?revision=2`, "DELETE")).status).toBe(204);
	expect((await s.call(path, "PUT", {})).status).toBe(405);
	expect((await s.call(`${s.prefix}/agent/invalid`)).status).toBe(404);
	expect((await s.call(`${path}/bad!`)).status).toBe(404);
	expect((await s.call(path, "POST", [])).status).toBe(400);
	expect((await s.call(`${path}?limit=101`)).status).toBe(400);
});
it("manages only explicit local configuration and durable refresh controls", async () => {
	const s = await setup();
	const p = s.prefix;
	expect((await s.call(`${p}/settings`)).status).toBe(200);
	for (const kind of ["stars", "statistics"]) {
		const path = `${p}/${kind}/nocoo/app`;
		expect((await s.call(path, "PUT", { enabled: false })).status).toBe(200);
		expect((await s.call(path, "GET")).status).toBe(405);
		expect((await s.call(path, "DELETE")).status).toBe(204);
	}
	expect((await s.call(`${p}/statistics/nocoo/app`, "PUT", {})).status).toBe(400);
	for (const kind of ["daily", "weekly", "catalog"]) {
		const path = `${p}/schedules/${kind}`;
		const body = {
			enabled: true,
			time: "08:00",
			weekday: 0,
			scope: kind === "daily" ? "starred" : "all",
		};
		expect((await s.call(path, "PUT", body)).status).toBe(200);
		expect((await s.call(path, "DELETE")).status).toBe(204);
	}
	expect((await s.call(`${p}/schedules/no`, "PUT", {})).status).toBe(400);
	expect(
		(
			await s.call(`${p}/schedules/daily`, "PUT", {
				enabled: true,
				time: "08:00",
				weekday: 0,
				scope: "all",
			})
		).status,
	).toBe(400);
	expect((await s.call(`${p}/schedules/catalog`, "PUT", {})).status).toBe(400);
	expect((await s.call(`${p}/refresh-runs`)).status).toBe(200);
	expect((await s.call(`${p}/refresh-runs`, "DELETE")).status).toBe(405);
	expect((await s.call(`${p}/refresh-runs`, "POST", {})).status).toBe(400);
	expect((await s.call(`${p}/refresh-runs/no/control`, "POST", {})).status).toBe(400);
	expect((await s.call(`${p}/refresh-runs/no/control`, "POST", { action: "pause" })).status).toBe(
		404,
	);
	const run = await s.call(`${p}/refresh-runs`, "POST", {
		requestKey: crypto.randomUUID(),
		mode: "catalog",
		scope: "all",
	});
	expect(run.status).toBe(202);
	const id = ((await run.json()) as { id: string }).id;
	expect(
		(await s.call(`${p}/refresh-runs/${id}/control`, "POST", { action: "pause" })).status,
	).toBe(202);
	expect(
		(await s.call(`${p}/refresh-runs/${id}/control`, "POST", { action: "resume" })).status,
	).toBe(202);
	expect(
		(await s.call(`${p}/refresh-runs/${id}/control`, "POST", { action: "cancel" })).status,
	).toBe(202);
});
