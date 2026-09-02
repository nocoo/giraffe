// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/errors";
import {
	accountFieldError,
	accountsArePublic,
	activateAccount,
	createAccount,
	deleteAccount,
	emptyToken,
	loadAccounts,
	type PublicAccount,
	shouldRefreshOnCreate,
} from "./accounts";
import { getActiveAccountId, setActiveAccountId } from "./session";

const PAT = `ghp_${"A".repeat(36)}`;

describe("accounts viewmodel", () => {
	afterEach(() => {
		setActiveAccountId(null);
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("clears the token and refreshes only the active account", async () => {
		expect(emptyToken()).toBe("");
		expect(shouldRefreshOnCreate({ is_active: true })).toBe(true);
		expect(shouldRefreshOnCreate({ is_active: false })).toBe(false);
		const publicRow = {
			id: "a",
			login: "octocat",
			avatar_url: "",
			token_last4: "AAAA",
			scopes: "repo",
			capabilities: { repo: true },
			is_active: true,
		};
		expect(accountsArePublic([publicRow])).toBe(true);
		expect(accountsArePublic([{ ...publicRow, token: PAT } as PublicAccount])).toBe(false);
		expect(
			accountFieldError(new ApiError(400, "scopes_missing", "缺少权限：read:org、notifications")),
		).toBe("缺少权限：read:org、notifications");
		expect(accountFieldError(new Error("x"))).toBeNull();
		expect(accountFieldError(new ApiError(400, "validation_failed", "bad"))).toBe("bad");

		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			urls.push(`${init?.method ?? "GET"} ${url}`);
			if (url === "/api/accounts" && (init?.method ?? "GET") === "GET") {
				return Response.json({ accounts: [{ id: "acc1", login: "octocat", is_active: true }] });
			}
			if (url === "/api/accounts" && init?.method === "POST") {
				expect(String(init.body)).toContain(PAT);
				return Response.json(
					{
						id: "acc1",
						login: "octocat",
						avatar_url: "",
						token_last4: "AAAA",
						scopes: "repo",
						capabilities: { repo: true },
						is_active: true,
					},
					{ status: 201 },
				);
			}
			if (url === "/api/refresh") {
				expect(String(init?.body)).toContain("acc1");
				expect(String(init?.body)).toContain("repos");
				return Response.json({ account_id: "acc1", kinds: ["repos"] });
			}
			if (url === "/api/insights" || url === "/api/digest" || url === "/api/repos") {
				return new Response(JSON.stringify({ error: { code: "snapshot_missing", message: "n" } }), {
					status: 409,
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error(url);
		});
		const created = await createAccount(PAT);
		expect(created.id).toBe("acc1");
		expect(getActiveAccountId()).toBe("acc1");
		expect(urls.some((row) => row.startsWith("POST /api/refresh"))).toBe(true);
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "/api/accounts" && init?.method === "POST") {
				return Response.json(
					{
						id: "acc3",
						login: "hubot",
						avatar_url: "",
						token_last4: "CCCC",
						scopes: "repo",
						capabilities: { repo: true },
						is_active: true,
					},
					{ status: 201 },
				);
			}
			if (url === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc3", login: "hubot", is_active: true }] });
			}
			throw new Error("refresh boom");
		});
		const still = await createAccount(PAT);
		expect(still.id).toBe("acc3");
	});

	it("does not refresh after creating a non-active account", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			urls.push(String(input));
			if (String(input) === "/api/accounts") {
				return Response.json(
					{
						id: "acc2",
						login: "other",
						avatar_url: "",
						token_last4: "BBBB",
						scopes: "repo",
						capabilities: { repo: true },
						is_active: false,
					},
					{ status: 201 },
				);
			}
			throw new Error(String(input));
		});
		await createAccount(PAT);
		expect(urls).toEqual(["/api/accounts"]);
		expect(getActiveAccountId()).toBeNull();
	});

	it("loads, activates, and deletes accounts", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			urls.push(`${init?.method ?? "GET"} ${url}`);
			if (url === "/api/accounts" && !init?.method) {
				return Response.json({
					accounts: [
						{
							id: "acc2",
							login: "octocat",
							avatar_url: "",
							token_last4: "AAAA",
							scopes: "repo",
							capabilities: { repo: true },
							is_active: true,
						},
					],
				});
			}
			if (url === "/api/accounts/acc2/activate") {
				return Response.json({ id: "acc2", is_active: true });
			}
			if (url === "/api/refresh") {
				return Response.json({ account_id: "acc2", kinds: ["repos"] });
			}
			if (url === "/api/insights" || url === "/api/digest" || url === "/api/repos") {
				return new Response(JSON.stringify({ error: { code: "snapshot_missing", message: "n" } }), {
					status: 409,
					headers: { "content-type": "application/json" },
				});
			}
			if (url === "/api/accounts/acc2" && init?.method === "DELETE") {
				return new Response(null, { status: 204 });
			}
			throw new Error(`${init?.method} ${url}`);
		});
		const rows = await loadAccounts();
		expect(accountsArePublic(rows)).toBe(true);
		await activateAccount("acc2");
		expect(getActiveAccountId()).toBe("acc2");
		await deleteAccount("acc2");
		expect(getActiveAccountId()).toBeNull();
		expect(urls).toContain("POST /api/accounts/acc2/activate");
		expect(urls).toContain("DELETE /api/accounts/acc2");
	});

	it("keeps activation when the follow-up refresh fails", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "/api/accounts/acc2/activate") {
				return Response.json({ id: "acc2", is_active: true });
			}
			if (url === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc2", login: "octocat", is_active: true }] });
			}
			if (url === "/api/refresh") {
				throw new Error("refresh boom");
			}
			throw new Error(`${init?.method} ${url}`);
		});
		await activateAccount("acc2");
		expect(getActiveAccountId()).toBe("acc2");
	});
});
