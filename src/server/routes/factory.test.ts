import { afterEach, describe, expect, it, vi } from "vitest";
import { NOW, rawRepo, ready } from "../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../tests/fixtures/sqlite";
import type { FactorySnapshot } from "../../lib/factory-types";
import type { Env } from "../env";
import { createApp } from "../index";
import { insertAccountStmt } from "../lib/db/accounts";
import { createDb } from "../lib/db/d1";
import { readSnapshot, replaceSnapshotStmts } from "../lib/db/snapshots";
import { encryptToken, parseKeyBytes } from "../lib/token-crypto";

const KEY = "0".repeat(64);
const ID = "a".repeat(21);
const headers = { origin: "https://giraffe.dev.hexly.ai", "content-type": "application/json" };
async function setup(withAccount = true) {
	const env = {
		DB: sqliteFixture(),
		ASSETS: { fetch: async () => new Response("app") },
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://127.0.0.1:17046",
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
		TOKEN_ENCRYPTION_KEY_V1: KEY,
	} as unknown as Env;
	const db = createDb(env.DB);
	if (withAccount)
		await db.batch([
			insertAccountStmt(db, {
				id: ID,
				login: "nocoo",
				avatar_url: "",
				token_ciphertext: await encryptToken("test-pat", parseKeyBytes(KEY)),
				token_last4: "-pat",
				key_version: 1,
				scopes: "repo",
				capabilities: "{}",
				is_active: 1,
				created_at: NOW,
				updated_at: NOW,
				last_used_at: null,
			}),
		]);
	const app = createApp();
	return {
		env,
		db,
		call: (path = "/api/factory", body?: unknown, method = body === undefined ? "GET" : "POST") =>
			app.request(
				`http://localhost${path}`,
				{ method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
				env,
			),
	};
}
afterEach(() => vi.unstubAllGlobals());
describe("factory API", () => {
	it("requires an active account and valid body, preserves read-only GET", async () => {
		const noAccount = await setup(false);
		expect((await noAccount.call()).status).toBe(409);
		const s = await setup();
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		expect((await s.call()).status).toBe(409);
		expect(fetch).not.toHaveBeenCalled();
		expect((await s.call("/api/factory/refresh", {})).status).toBe(400);
		expect((await s.call("/api/factory/refresh", { account_id: "b".repeat(21) })).status).toBe(409);
		Reflect.deleteProperty(s.env, "TOKEN_ENCRYPTION_KEY_V1");
		expect((await s.call("/api/factory/refresh", { account_id: ID })).status).toBe(500);
	});
	it("collects in bounded batches, resumes and protects stale detail from a fresh run", async () => {
		const s = await setup();
		let calls = 0;
		vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
			calls++;
			const q = String(init.body);
			if (q.includes("repositories(first"))
				return Response.json({
					data: {
						viewer: {
							login: "nocoo",
							repositories: { totalCount: 1, nodes: [rawRepo], pageInfo: { hasNextPage: false } },
						},
					},
				});
			if (q.includes("contributionsCollection")) return Response.json({ data: { user: null } });
			if (q.includes("object(expression")) return Response.json({ data: { repository: {} } });
			return Response.json(
				String(_url).includes("actions/runs") ? { total_count: 0, workflow_runs: [] } : [],
			);
		});
		let res = await s.call("/api/factory/refresh", { account_id: ID });
		expect(res.status).toBe(200);
		expect(calls).toBe(6);
		const first = (await res.json()) as FactorySnapshot;
		expect(first.status).toBe("collecting");
		res = await s.call("/api/factory/refresh", { account_id: ID });
		expect(((await res.json()) as FactorySnapshot).status).toBe("complete");
		res = await s.call();
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		const before = calls;
		await s.call("/api/factory/refresh", { account_id: ID });
		expect(calls).toBe(before);
		const detail = await s.call("/api/factory/repos/nocoo/app/commits");
		expect(detail.status).toBe(200);
		expect(((await detail.json()) as { total: number }).total).toBe(0);
		expect((await s.call("/api/factory/repos/nocoo/no/commits")).status).toBe(404);
		expect((await s.call("/api/factory/repos/nocoo/app/other")).status).toBe(400);
		expect((await s.call("/api/factory/repos/nocoo/app/prs?page=0")).status).toBe(400);
		const fresh = ready();
		await s.db.batch(replaceSnapshotStmts(s.db, ID, "factory", { ...fresh }, NOW));
		const pending = await s.call("/api/factory/repos/nocoo/app/commits");
		expect(((await pending.json()) as { coverage: { status: string } }).coverage.status).toBe(
			"pending",
		);
		await s.call("/api/factory/refresh", { account_id: ID, restart: true });
		expect(calls).toBeGreaterThan(before);
	});
	it("checkpoints successful pages before rate limits and releases the lease for retry", async () => {
		const s = await setup();
		const state = ready("issues");
		await s.db.batch(replaceSnapshotStmts(s.db, ID, "factory", { ...state }, NOW));
		let calls = 0;
		vi.stubGlobal("fetch", async () =>
			++calls === 1 ? Response.json([]) : Response.json({ message: "rate limit" }, { status: 429 }),
		);
		expect((await s.call("/api/factory/refresh", { account_id: ID })).status).toBe(503);
		const saved = (await readSnapshot(s.db, ID, "factory")) as FactorySnapshot;
		expect(saved.cursor.stream).toBe(2);
		vi.stubGlobal("fetch", async () => Response.json([]));
		expect((await s.call("/api/factory/refresh", { account_id: ID })).status).toBe(502); // Actions payload invalid, but the lease was available.
	});
	it("serializes concurrent isolates with an expiring SQLite lease", async () => {
		const s = await setup();
		const lock = s.db
			.prepare("INSERT INTO snapshots (account_id, kind, payload, fetched_at) VALUES (?, ?, ?, ?)")
			.bind(ID, "factory:lock", "other", "2999-01-01T00:00:00Z");
		await lock.run();
		expect((await s.call("/api/factory/refresh", { account_id: ID })).status).toBe(409);
		await s.db
			.prepare("UPDATE snapshots SET fetched_at = ? WHERE account_id = ? AND kind = ?")
			.bind("2000-01-01T00:00:00Z", ID, "factory:lock")
			.run();
		vi.stubGlobal("fetch", async () => Response.json({ message: "rate limit" }, { status: 429 }));
		expect((await s.call("/api/factory/refresh", { account_id: ID })).status).toBe(503);
	});
});
