import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidRepoPart, loadRepoTab, REPO_TABS, repoKind, repoResource } from "./repo-detail";
import { setActiveAccountId } from "./session";

describe("repo-detail viewmodel", () => {
	afterEach(() => {
		setActiveAccountId(null);
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("rejects illegal owner or name without fetching", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			urls.push(String(input));
			throw new Error("no");
		});
		expect(isValidRepoPart("octocat")).toBe(true);
		expect(isValidRepoPart(".")).toBe(false);
		expect(isValidRepoPart("..")).toBe(false);
		expect(isValidRepoPart("o!")).toBe(false);
		expect(await loadRepoTab("o!", "hello", "details")).toEqual({ invalid: true });
		expect(await loadRepoTab(".", "hello", "details")).toEqual({ invalid: true });
		expect(await loadRepoTab("octocat", "..", "details")).toEqual({ invalid: true });
		expect(urls).toEqual([]);
	});

	it("binds each tab to the correct GET path", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			urls.push(String(input));
			if (String(input) === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			return Response.json({ account_id: "acc1" });
		});
		for (const tab of REPO_TABS) {
			await loadRepoTab("octocat", "hello-world", tab);
		}
		expect(urls.filter((url) => url.startsWith("/api/repos/"))).toEqual([
			"/api/repos/octocat/hello-world",
			"/api/repos/octocat/hello-world/security",
			"/api/repos/octocat/hello-world/actions",
			"/api/repos/octocat/hello-world/prs",
			"/api/repos/octocat/hello-world/issues",
			"/api/repos/octocat/hello-world/releases",
			"/api/repos/octocat/hello-world/traffic",
			"/api/repos/octocat/hello-world/languages",
			"/api/repos/octocat/hello-world/contributors",
		]);
		expect(repoResource("o", "n", "details")).toBe("repos/o/n");
		expect(repoKind("o", "n", "security")).toBe("repo:o/n:security");
	});

	it("maps snapshot_missing and rethrows other errors", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (String(input) === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			return new Response(JSON.stringify({ error: { code: "snapshot_missing", message: "n" } }), {
				status: 409,
				headers: { "content-type": "application/json" },
			});
		});
		expect(await loadRepoTab("octocat", "hello-world", "details")).toEqual({ missing: true });
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (String(input) === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			return new Response(JSON.stringify({ error: { code: "github_error", message: "x" } }), {
				status: 502,
				headers: { "content-type": "application/json" },
			});
		});
		await expect(loadRepoTab("octocat", "hello-world", "details")).rejects.toMatchObject({
			code: "github_error",
		});
	});
});
