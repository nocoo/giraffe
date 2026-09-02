import { afterEach, describe, expect, it, vi } from "vitest";
import { filterIssues, type IssueRow, loadIssues } from "./issues";
import { setActiveAccountId } from "./session";
import { clearSnapshots } from "./snapshot";

const sample: IssueRow[] = [
	{
		name_with_owner: "octocat/hello-world",
		number: 1,
		title: "Broken login",
		url: "https://github.com/octocat/hello-world/issues/1",
		created_at: "2026-08-01T00:00:00.000Z",
		updated_at: "2026-08-02T00:00:00.000Z",
		author_login: "octocat",
		labels: [{ name: "bug", color: "d73a4a" }],
		comments_count: 2,
	},
	{
		name_with_owner: "octocat/alpha",
		number: 4,
		title: "Add docs",
		url: "https://github.com/octocat/alpha/issues/4",
		created_at: "2026-08-03T00:00:00.000Z",
		updated_at: "2026-08-04T00:00:00.000Z",
		author_login: null,
		labels: [],
		comments_count: 0,
	},
];

describe("issues viewmodel", () => {
	afterEach(() => {
		setActiveAccountId(null);
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("filters by repo or title", () => {
		expect(filterIssues(sample, "hello").map((row) => row.number)).toEqual([1]);
		expect(filterIssues(sample, "docs").map((row) => row.number)).toEqual([4]);
		expect(filterIssues(sample, "  ").map((row) => row.number)).toEqual([1, 4]);
	});

	it("loads issues after session and maps snapshot_missing", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			if (url === "/api/issues") {
				return Response.json({
					account_id: "acc1",
					fetched_at: "2026-09-01T00:00:00.000Z",
					truncated: false,
					issues: sample,
				});
			}
			throw new Error(url);
		});
		const snap = await loadIssues();
		expect("missing" in snap).toBe(false);
		if (!("missing" in snap)) {
			expect(snap.issues).toHaveLength(2);
		}
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
		expect(await loadIssues()).toEqual({ missing: true });
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
		await expect(loadIssues()).rejects.toMatchObject({ code: "github_error" });
	});
});
