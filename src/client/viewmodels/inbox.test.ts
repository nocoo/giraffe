import { afterEach, describe, expect, it, vi } from "vitest";
import { applyRead, applyReadAll, loadInbox, markRead, markReadAll } from "./inbox";
import { setActiveAccountId } from "./session";
import { clearSnapshots } from "./snapshot";

const snap = {
	account_id: "acc1",
	fetched_at: "t",
	truncated: false,
	notifications: [
		{
			id: "1",
			unread: true,
			reason: "mention",
			updated_at: "2026-09-01T00:00:00.000Z",
			title: "Hello",
			url: "https://github.com/octocat/hello-world/issues/1",
			name_with_owner: "octocat/hello-world",
		},
		{
			id: "2",
			unread: true,
			reason: "review_requested",
			updated_at: "2026-09-01T01:00:00.000Z",
			title: "PR",
			url: "https://github.com/octocat/alpha/pull/2",
			name_with_owner: "octocat/alpha",
		},
	],
};

describe("inbox viewmodel", () => {
	afterEach(() => {
		setActiveAccountId(null);
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("reduces unread on read and read-all", () => {
		expect(applyRead(snap, "1").notifications.map((row) => row.unread)).toEqual([false, true]);
		expect(applyReadAll(snap).notifications.every((row) => row.unread === false)).toBe(true);
	});

	it("loads inbox after session and maps snapshot_missing", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			if (url === "/api/notifications") {
				return Response.json(snap);
			}
			throw new Error(url);
		});
		const loaded = await loadInbox();
		expect("missing" in loaded).toBe(false);
		clearSnapshots();
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (String(input) === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			return new Response(JSON.stringify({ error: { code: "snapshot_missing", message: "n" } }), {
				status: 409,
				headers: { "content-type": "application/json" },
			});
		});
		expect(await loadInbox()).toEqual({ missing: true });
	});

	it("posts read and read-all with account_id and replaces from body", async () => {
		const posts: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			if (url === "/api/notifications/read") {
				posts.push(String(init?.body));
				return Response.json(applyRead(snap, "1"));
			}
			if (url === "/api/notifications/read-all") {
				posts.push(String(init?.body));
				return Response.json(applyReadAll(snap));
			}
			throw new Error(url);
		});
		const one = await markRead("1", "acc1");
		expect(one.notifications[0]?.unread).toBe(false);
		expect(posts[0]).toContain('"account_id":"acc1"');
		expect(posts[0]).toContain('"id":"1"');
		const all = await markReadAll("acc1");
		expect(all.notifications.every((row) => !row.unread)).toBe(true);
		expect(posts[1]).toContain('"account_id":"acc1"');
		expect(posts).toHaveLength(2);
	});

	it("uses the snapshot account_id rather than the live session", async () => {
		setActiveAccountId("acc2");
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input) === "/api/notifications/read") {
				expect(String(init?.body)).toContain('"account_id":"acc1"');
				return Response.json(applyRead(snap, "1"));
			}
			throw new Error(String(input));
		});
		await markRead("1", "acc1");
	});

	it("does not replay on account_conflict", async () => {
		let posts = 0;
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			if (url === "/api/notifications/read" || url === "/api/notifications/read-all") {
				posts += 1;
				return new Response(
					JSON.stringify({ error: { code: "account_conflict", message: "changed" } }),
					{ status: 409, headers: { "content-type": "application/json" } },
				);
			}
			throw new Error(url);
		});
		await expect(markRead("1", "acc1")).rejects.toMatchObject({ code: "account_conflict" });
		await expect(markReadAll("acc1")).rejects.toMatchObject({ code: "account_conflict" });
		expect(posts).toBe(2);
	});

	it("rethrows unexpected snapshot errors", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (String(input) === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			return new Response(JSON.stringify({ error: { code: "github_error", message: "x" } }), {
				status: 502,
				headers: { "content-type": "application/json" },
			});
		});
		await expect(loadInbox()).rejects.toMatchObject({ code: "github_error" });
	});
});
