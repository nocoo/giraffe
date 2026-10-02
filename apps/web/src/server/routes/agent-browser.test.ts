import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";
import { createDb } from "../lib/db/d1";
import { replaceSnapshotStmts } from "../lib/db/snapshots";

const account = "a".repeat(21),
	other = "b".repeat(21);
it("uses Access and active account with same-origin CRUD and read-only provenance", async () => {
	const DB = sqliteFixture();
	for (const id of [account, other])
		await DB.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?,?, 'fake','fake',?,'t','t')",
		)
			.bind(id, id === account ? "nocoo" : "other", Number(id === account))
			.run();
	const db = createDb(DB);
	await db.batch(
		replaceSnapshotStmts(
			db,
			account,
			"repos",
			{
				repos: [
					{ name_with_owner: "nocoo/app", owner_login: "nocoo" },
					{ name_with_owner: "nocoo/archive", owner_login: "nocoo", is_archived: true },
				],
			},
			"2026-10-02T08:00:00Z",
		),
	);
	await db.batch(
		replaceSnapshotStmts(
			db,
			account,
			"repo:nocoo/app:issues",
			{ issues: [] },
			"2026-10-02T08:00:00Z",
		),
	);
	await db.batch(
		replaceSnapshotStmts(
			db,
			account,
			"repo:nocoo/app:details",
			{ default_branch: "main" },
			"2026-10-02T08:00:00Z",
		),
	);
	const publication = factoryFixture();
	publication.account_id = account;
	const observed = publication.repos[0];
	if (!observed) throw new Error("fixture missing");
	observed.name = "nocoo/app";
	observed.observation = {
		version: "immutable-v1",
		window: publication.window,
		refreshedAt: "2026-10-02T08:00:00Z",
		source: "run",
	};
	await db.batch(
		replaceSnapshotStmts(db, account, "factory:v:pub", publication, "2026-10-02T08:00:00Z"),
	);
	await db
		.prepare("INSERT INTO factory_state(account_id,published_id,next_at) VALUES(?,'pub','t')")
		.bind(account)
		.run();
	const env = { DB, ENVIRONMENT: "development", GITHUB_API_BASE: "http://fixture" } as Env;
	const app = createApp();
	const prefix = `/api/agent/accounts/${account}`;
	const call = (
		path: string,
		method = "GET",
		body?: unknown,
		origin = "https://giraffe.dev.hexly.ai",
	) =>
		app.request(
			`http://localhost${path}`,
			{
				method,
				headers: { origin, "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
			env,
		);
	expect(
		(
			await app.request(
				`http://localhost${prefix}/reports`,
				{},
				{ ...env, ENVIRONMENT: "production" },
			)
		).status,
	).toBe(401);
	expect((await call(`/api/agent/accounts/${other}/reports`)).status).toBe(409);
	const body = {
		type: "analysis-request",
		status: "pending",
		payload: { scope: "repo", repository: "nocoo/app", domains: ["issues"] },
	};
	expect((await call(`${prefix}/jobs`, "POST", body, "https://evil.test")).status).toBe(403);
	const created = await call(`${prefix}/jobs`, "POST", body);
	expect(created.status).toBe(201);
	const id = ((await created.json()) as { item: { id: string } }).item.id;
	expect((await call(`${prefix}/jobs/${id}`)).status).toBe(200);
	expect(
		(await call(`${prefix}/jobs/${id}`, "PATCH", { revision: 1, status: "cancelled" })).status,
	).toBe(200);
	expect((await call(`${prefix}/jobs/${id}?revision=2`, "DELETE")).status).toBe(204);
	expect((await call(`${prefix}/jobs/${id}`)).status).toBe(404);
	expect((await call(`${prefix}/bad`)).status).toBe(404);
	expect((await call(`${prefix}/jobs`, "PUT", {})).status).toBe(405);
	expect(
		(
			await call(`${prefix}/jobs`, "POST", {
				...body,
				payload: { scope: "global", repository: "nocoo/app", domains: ["ci"] },
			})
		).status,
	).toBe(400);
	const sources = await call(`${prefix}/sources?repository=nocoo%2Fapp`);
	expect(sources.status).toBe(200);
	const saved = (await sources.json()) as {
		repositories: string[];
		sources: { resource: string; version: string }[];
	};
	expect(saved.repositories).toEqual(["nocoo/app"]);
	expect(saved.sources.find((source) => source.resource === "repo:nocoo/app:details")).toBeTruthy();
	expect(saved.sources.find((source) => source.resource === "account:repos")).toBeTruthy();
	expect(saved.sources.find((source) => source.resource === "account:ci")).toBeTruthy();
	expect(saved.sources.find((source) => source.resource === "factory:nocoo/app:prs")?.version).toBe(
		"immutable-v1",
	);
	expect(saved).toMatchObject({
		account_id: account,
		sources: expect.arrayContaining([
			expect.objectContaining({
				resource: "repo:nocoo/app:issues",
				fetchedAt: "2026-10-02T08:00:00Z",
			}),
		]),
	});
	expect((await call(`${prefix}/sources?repository=nocoo%2Fmissing`)).status).toBe(404);
	expect((await call(`${prefix}/reports`)).status).toBe(200);
});
