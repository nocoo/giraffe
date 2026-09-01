import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { createApp } from "../index";
import { openSqliteD1 } from "../lib/db/sqlite-d1";

const PAT = `ghp_${"A".repeat(36)}`;

function env(): Env {
	return {
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
		expect(
			(
				await createApp().request(
					"http://localhost/api/accounts",
					{ method: "POST", headers, body: JSON.stringify({ token: PAT }) },
					e,
				)
			).status,
		).toBe(201);
		expect(
			(
				await createApp().request(
					"http://localhost/api/refresh",
					{ method: "POST", headers, body: JSON.stringify({ kinds: ["notifications"] }) },
					e,
				)
			).status,
		).toBe(200);
		const read = await createApp().request(
			"http://localhost/api/notifications/read",
			{ method: "POST", headers, body: JSON.stringify({ id: "123" }) },
			e,
		);
		expect(read.status).toBe(200);
		const after = (await read.json()) as { notifications: Array<{ id: string; unread: boolean }> };
		expect(after.notifications.find((n) => n.id === "123")?.unread).toBe(false);
		const all = await createApp().request(
			"http://localhost/api/notifications/read-all",
			{ method: "POST", headers: { origin: "https://giraffe.dev.hexly.ai" } },
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
					{ method: "POST", headers, body: JSON.stringify({ id: "abc" }) },
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
					{ method: "POST", headers, body: JSON.stringify({ id: "123" }) },
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
		await createApp().request(
			"http://localhost/api/accounts",
			{ method: "POST", headers, body: JSON.stringify({ token: PAT }) },
			e,
		);
		hits = 0;
		expect(
			(
				await createApp().request(
					"http://localhost/api/notifications/read-all",
					{ method: "POST", headers: { origin: "https://giraffe.dev.hexly.ai" } },
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
					{ method: "POST", headers: { origin: "https://giraffe.dev.hexly.ai" } },
					e,
				)
			).status,
		).toBe(200);
		expect(
			(
				await createApp().request(
					"http://localhost/api/notifications/read-all",
					{ method: "POST", headers: { origin: "https://giraffe.dev.hexly.ai" } },
					{ ...e, TOKEN_ENCRYPTION_KEY_V1: undefined } as Env,
				)
			).status,
		).toBe(500);
	});
});
