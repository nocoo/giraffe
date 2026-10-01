import { afterEach, describe, expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";
import { createDb } from "../lib/db/d1";
import { readSnapshot, replaceSnapshotStmts } from "../lib/db/snapshots";
import { openSqliteD1 } from "../lib/db/sqlite-d1";
import { MAX_FETCHES } from "../lib/github-client";
import { encryptToken, parseKeyBytes } from "../lib/token-crypto";

const PAT = `ghp_${"A".repeat(36)}`;

function env(): Env {
	return {
		FACTORY_QUEUE: {} as Queue,
		DB: openSqliteD1(true),
		ASSETS: { fetch: async () => new Response("x") } as unknown as Fetcher,
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
		TOKEN_ENCRYPTION_KEY_V1: "0".repeat(64),
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://127.0.0.1:17046",
	} as Env;
}

const headers = {
	origin: "https://giraffe.dev.hexly.ai",
	"content-type": "application/json",
};

const scopedAccount = "notifications_test_01";
const collectedAt = "2026-09-01T00:00:00.000Z";
async function scopedFixture() {
	const bindings = { ...env(), DB: sqliteFixture() };
	const db = createDb(bindings.DB);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?,?,?,'fake',1,?,?)",
		)
		.bind(
			scopedAccount,
			"owner",
			await encryptToken("fake-test-token", parseKeyBytes("0".repeat(64))),
			collectedAt,
			collectedAt,
		)
		.run();
	const save = (kind: string, payload: Record<string, unknown>) =>
		db.batch(replaceSnapshotStmts(db, scopedAccount, kind, payload, collectedAt));
	await save("repos", {
		repos: [
			{ name_with_owner: "owner/app" },
			{ name_with_owner: "owner/hidden" },
			{ name_with_owner: "owner/fork", is_fork: true },
		],
	});
	await save("notifications", {
		notifications: [
			{ id: "11", name_with_owner: "owner/app", unread: true },
			{ id: "12", name_with_owner: "OWNER/APP", unread: false },
			{ id: "13", name_with_owner: "owner/hidden", unread: true },
			{ id: "14", name_with_owner: "owner/fork", unread: true },
			{ id: "15", name_with_owner: "owner/app", unread: true },
		],
	});
	await db.prepare("INSERT INTO repo_stars VALUES(?, 'OWNER/APP')").bind(scopedAccount).run();
	await db.prepare("INSERT INTO repo_stars VALUES(?, 'owner/fork')").bind(scopedAccount).run();
	return {
		db,
		save,
		post: (path: string, body: unknown = { account_id: scopedAccount }, origin = headers.origin) =>
			createApp().request(
				`http://localhost/api/notifications/${path}`,
				{ method: "POST", headers: { ...headers, origin }, body: JSON.stringify(body) },
				bindings,
			),
	};
}

describe("scoped notification write-through", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("patches only saved selected unread threads serially, preserves collection time and leaves hidden rows untouched", async () => {
		const fixture = await scopedFixture();
		const requests: string[] = [];
		let active = false;
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			expect(active).toBe(false);
			active = true;
			requests.push(`${init?.method} ${new URL(String(input)).pathname}`);
			await Promise.resolve();
			active = false;
			return new Response(null, { status: 205 });
		});
		const response = await fixture.post("read-all?scope=starred");
		expect(response.status).toBe(200);
		expect(requests).toEqual([
			"PATCH /notifications/threads/11",
			"PATCH /notifications/threads/15",
		]);
		expect(await response.json()).toMatchObject({
			fetched_at: collectedAt,
			notifications: [
				{ id: "11", unread: false },
				{ id: "12", unread: false },
				{ id: "15", unread: false },
			],
		});
		expect(await readSnapshot(fixture.db, scopedAccount, "notifications")).toMatchObject({
			fetched_at: collectedAt,
			notifications: [
				{ id: "11", unread: false },
				{ id: "12", unread: false },
				{ id: "13", unread: true },
				{ id: "14", unread: true },
				{ id: "15", unread: false },
			],
		});
		const account = await fixture.db
			.prepare("SELECT last_used_at FROM accounts WHERE id=?")
			.bind(scopedAccount)
			.first<{ last_used_at: string }>();
		expect(Date.parse(account?.last_used_at ?? "")).toBeGreaterThan(Date.parse(collectedAt));
		expect(
			await fixture.db
				.prepare("SELECT fetched_at FROM snapshots WHERE account_id=? AND kind='notifications'")
				.bind(scopedAccount)
				.first(),
		).toEqual({ fetched_at: collectedAt });
	});

	it("leaves the entire saved snapshot and last-used time unchanged after partial upstream failure", async () => {
		const fixture = await scopedFixture();
		const before = await readSnapshot(fixture.db, scopedAccount, "notifications");
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(`${init?.method} ${new URL(String(input)).pathname}`);
			return requests.length === 1
				? new Response(null, { status: 205 })
				: new Response("denied", { status: 403 });
		});
		expect((await fixture.post("read-all?scope=starred")).status).toBe(403);
		expect(requests).toEqual([
			"PATCH /notifications/threads/11",
			"PATCH /notifications/threads/15",
		]);
		expect(await readSnapshot(fixture.db, scopedAccount, "notifications")).toEqual(before);
		expect(
			await fixture.db
				.prepare("SELECT last_used_at FROM accounts WHERE id=?")
				.bind(scopedAccount)
				.first(),
		).toEqual({ last_used_at: null });
	});

	it("validates scope, saved thread membership, account fence, Origin and bounded thread counts before upstream", async () => {
		const fixture = await scopedFixture();
		const network = vi.fn();
		vi.stubGlobal("fetch", network);
		for (const action of ["read", "read-all"])
			expect(
				(await fixture.post(`${action}?scope=bad`, { account_id: scopedAccount, id: "11" })).status,
			).toBe(400);
		expect((await fixture.post("read-all?scope=all&scope=starred")).status).toBe(400);
		for (const id of ["13", "14", "999"])
			expect(
				(await fixture.post("read?scope=starred", { account_id: scopedAccount, id })).status,
			).toBe(404);
		expect(
			(await fixture.post("read-all?scope=starred", { account_id: "notifications_test_02" }))
				.status,
		).toBe(409);
		expect(
			(await fixture.post("read-all?scope=starred", undefined, "https://attacker.invalid")).status,
		).toBe(403);
		await fixture.save("notifications", {
			notifications: Array.from({ length: MAX_FETCHES + 1 }, (_, index) => ({
				id: String(index + 1),
				name_with_owner: "owner/app",
				unread: true,
			})),
		});
		expect((await fixture.post("read-all?scope=starred")).status).toBe(422);
		expect(network).not.toHaveBeenCalled();
	});

	it("performs no upstream writes for empty scope or already-read threads and retains explicit all PUT", async () => {
		const fixture = await scopedFixture();
		const before = await readSnapshot(fixture.db, scopedAccount, "notifications");
		const network = vi.fn(async () => new Response(null, { status: 205 }));
		vi.stubGlobal("fetch", network);
		await fixture.db.prepare("DELETE FROM repo_stars WHERE account_id=?").bind(scopedAccount).run();
		expect(await (await fixture.post("read-all?scope=starred")).json()).toMatchObject({
			notifications: [],
			fetched_at: collectedAt,
		});
		expect(await readSnapshot(fixture.db, scopedAccount, "notifications")).toEqual(before);
		expect(network).not.toHaveBeenCalled();
		const response = await fixture.post("read-all?scope=all");
		expect(response.status).toBe(200);
		expect(network).toHaveBeenCalledOnce();
		expect(network).toHaveBeenCalledWith(
			expect.stringContaining("/notifications"),
			expect.objectContaining({ method: "PUT" }),
		);
		expect(await response.json()).toMatchObject({ fetched_at: collectedAt });
	});

	it("preserves collection time and scope after marking one selected thread", async () => {
		const fixture = await scopedFixture();
		const network = vi.fn(async () => new Response(null, { status: 205 }));
		vi.stubGlobal("fetch", network);
		const response = await fixture.post("read?scope=starred", {
			account_id: scopedAccount,
			id: "11",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			fetched_at: collectedAt,
			notifications: [
				{ id: "11", unread: false },
				{ id: "12", unread: false },
				{ id: "15", unread: true },
			],
		});
		expect((await readSnapshot(fixture.db, scopedAccount, "notifications"))?.fetched_at).toBe(
			collectedAt,
		);
	});

	it("rejects malformed saved thread identifiers and deduplicates safe selected IDs", async () => {
		const fixture = await scopedFixture();
		const network = vi.fn(async () => new Response(null, { status: 205 }));
		vi.stubGlobal("fetch", network);
		await fixture.save("notifications", {
			notifications: [{ id: "../hidden", name_with_owner: "owner/app", unread: true }],
		});
		expect((await fixture.post("read-all?scope=starred")).status).toBe(422);
		expect(network).not.toHaveBeenCalled();
		await fixture.save("notifications", {
			notifications: [
				{ id: "1", name_with_owner: "owner/app", unread: true },
				{ id: "1", name_with_owner: "owner/app", unread: true },
			],
		});
		expect((await fixture.post("read-all?scope=starred")).status).toBe(200);
		expect(network).toHaveBeenCalledOnce();
		await fixture.save("notifications", {
			notifications: [{ id: "1", name_with_owner: "owner/app", unread: false }],
		});
		expect((await fixture.post("read-all?scope=starred")).status).toBe(200);
		expect(network).toHaveBeenCalledOnce();
	});
});

describe("notification write-through", () => {
	afterEach(() => {
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("marks one thread and all threads read", async () => {
		const e = env();
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/user")) {
				return new Response(JSON.stringify({ login: "octocat", avatar_url: "" }), {
					headers: { "X-OAuth-Scopes": "repo, read:org, read:user, notifications" },
				});
			}
			if (url.endsWith("/graphql")) {
				return Response.json({
					data: { viewer: { repositories: { nodes: [], pageInfo: { hasNextPage: false } } } },
				});
			}
			if (url.includes("/notifications/threads/123") && init?.method === "PATCH") {
				return new Response(null, { status: 205 });
			}
			if (url.endsWith("/notifications") && init?.method === "PUT") {
				return new Response(null, { status: 205 });
			}
			if (url.includes("/notifications")) {
				return Response.json([
					{ id: "123", unread: true, subject: { title: "t" }, repository: { full_name: "o/n" } },
					{ id: "456", unread: true, subject: { title: "u" }, repository: { full_name: "o/n" } },
				]);
			}
			throw new Error(`unexpected ${url}`);
		});
		const created = await createApp().request(
			"http://localhost/api/accounts",
			{ method: "POST", headers, body: JSON.stringify({ token: PAT }) },
			e,
		);
		expect(created.status).toBe(201);
		const accountId = ((await created.json()) as { id: string }).id;
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{
						method: "POST",
						headers,
						body: JSON.stringify({ account_id: accountId, kinds: ["notifications"] }),
					},
					e,
				)
			).status,
		).toBe(200);
		const read = await createApp().request(
			"http://localhost/api/notifications/read",
			{ method: "POST", headers, body: JSON.stringify({ id: "123", account_id: accountId }) },
			e,
		);
		expect(read.status).toBe(200);
		const after = (await read.json()) as { notifications: Array<{ id: string; unread: boolean }> };
		expect(after.notifications.find((n) => n.id === "123")?.unread).toBe(false);
		const all = await createApp().request(
			"http://localhost/api/notifications/read-all",
			{
				method: "POST",
				headers,
				body: JSON.stringify({ account_id: accountId }),
			},
			e,
		);
		expect(all.status).toBe(200);
		expect(
			((await all.json()) as { notifications: Array<{ unread: boolean }> }).notifications.every(
				(n) => !n.unread,
			),
		).toBe(true);
		expect(
			(
				await createApp().request(
					"http://localhost/api/notifications/read",
					{ method: "POST", headers, body: JSON.stringify({ id: "abc", account_id: accountId }) },
					e,
				)
			).status,
		).toBe(400);
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes("/notifications/threads/") && init?.method === "PATCH") {
				return new Response("no", { status: 404 });
			}
			throw new Error("unexpected");
		});
		expect(
			(
				await createApp().request(
					"http://localhost/api/notifications/read",
					{ method: "POST", headers, body: JSON.stringify({ id: "123", account_id: accountId }) },
					e,
				)
			).status,
		).toBe(404);
	});

	it("does not call github without a snapshot", async () => {
		const e = env();
		let hits = 0;
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			hits += 1;
			const url = String(input);
			if (url.endsWith("/user")) {
				return new Response(JSON.stringify({ login: "octocat", avatar_url: "" }), {
					headers: { "X-OAuth-Scopes": "repo, read:org, read:user, notifications" },
				});
			}
			throw new Error(`unexpected ${url}`);
		});
		const created = await createApp().request(
			"http://localhost/api/accounts",
			{ method: "POST", headers, body: JSON.stringify({ token: PAT }) },
			e,
		);
		const accountId = ((await created.json()) as { id: string }).id;
		hits = 0;
		expect(
			(
				await createApp().request(
					"http://localhost/api/notifications/read-all",
					{
						method: "POST",
						headers,
						body: JSON.stringify({ account_id: "x" }),
					},
					e,
				)
			).status,
		).toBe(400);
		expect(hits).toBe(0);
		expect(
			(
				await createApp().request(
					"http://localhost/api/notifications/read-all",
					{
						method: "POST",
						headers,
						body: JSON.stringify({ account_id: accountId }),
					},
					e,
				)
			).status,
		).toBe(409);
		expect(hits).toBe(0);
	});

	it("handles a snapshot without a list and missing encryption", async () => {
		const e = env();
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/user")) {
				return new Response(JSON.stringify({ login: "octocat", avatar_url: "" }), {
					headers: { "X-OAuth-Scopes": "repo, read:org, read:user, notifications" },
				});
			}
			throw new Error(`unexpected ${url}`);
		});
		const created = await createApp().request(
			"http://localhost/api/accounts",
			{ method: "POST", headers, body: JSON.stringify({ token: PAT }) },
			e,
		);
		const { id } = (await created.json()) as { id: string };
		const { createDb } = await import("../lib/db/d1");
		const { replaceSnapshotStmts } = await import("../lib/db/snapshots");
		const db = createDb(e.DB);
		await db.batch(replaceSnapshotStmts(db, id, "notifications", { truncated: false }, "t"));
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/notifications") && init?.method === "PUT") {
				return new Response(null, { status: 202 });
			}
			throw new Error("unexpected");
		});
		expect(
			(
				await createApp().request(
					"http://localhost/api/notifications/read-all",
					{ method: "POST", headers, body: JSON.stringify({ account_id: id }) },
					e,
				)
			).status,
		).toBe(200);
		await db.batch(
			replaceSnapshotStmts(
				db,
				id,
				"notifications",
				{ truncated: false, notifications: [1, { id: "1", unread: true }] },
				"t",
			),
		);
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/notifications") && init?.method === "PUT") {
				return new Response(null, { status: 202 });
			}
			throw new Error("unexpected");
		});
		expect(
			(
				await createApp().request(
					"http://localhost/api/notifications/read-all",
					{ method: "POST", headers, body: JSON.stringify({ account_id: id }) },
					e,
				)
			).status,
		).toBe(200);
		expect(
			(
				await createApp().request(
					"http://localhost/api/notifications/read-all",
					{ method: "POST", headers, body: JSON.stringify({ account_id: id }) },
					{ ...e, TOKEN_ENCRYPTION_KEY_V1: undefined } as Env,
				)
			).status,
		).toBe(500);
	});
});
