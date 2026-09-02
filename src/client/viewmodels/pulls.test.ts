import { afterEach, describe, expect, it, vi } from "vitest";
import { filterPulls, loadPulls, type PullRow } from "./pulls";
import { setActiveAccountId } from "./session";

const sample: PullRow[] = [
	{
		name_with_owner: "octocat/hello-world",
		number: 2,
		title: "Fix login",
		url: "https://github.com/octocat/hello-world/pull/2",
		created_at: "2026-08-01T00:00:00.000Z",
		updated_at: "2026-08-02T00:00:00.000Z",
		author_login: "octocat",
		is_draft: false,
		review_decision: "APPROVED",
		additions: 10,
		deletions: 2,
		base_ref: "main",
		head_ref: "fix",
	},
	{
		name_with_owner: "octocat/alpha",
		number: 9,
		title: "Draft docs",
		url: "https://github.com/octocat/alpha/pull/9",
		created_at: "2026-08-03T00:00:00.000Z",
		updated_at: "2026-08-04T00:00:00.000Z",
		author_login: null,
		is_draft: true,
		review_decision: null,
		additions: 1,
		deletions: 0,
		base_ref: "main",
		head_ref: "docs",
	},
];

describe("pulls viewmodel", () => {
	afterEach(() => {
		setActiveAccountId(null);
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("filters by repo or title", () => {
		expect(filterPulls(sample, "hello").map((row) => row.number)).toEqual([2]);
		expect(filterPulls(sample, "docs").map((row) => row.number)).toEqual([9]);
		expect(filterPulls(sample, "").map((row) => row.number)).toEqual([2, 9]);
	});

	it("loads prs after session and maps snapshot_missing", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			if (url === "/api/prs") {
				return Response.json({
					account_id: "acc1",
					fetched_at: "2026-09-01T00:00:00.000Z",
					truncated: false,
					pull_requests: sample,
				});
			}
			throw new Error(url);
		});
		const snap = await loadPulls();
		expect("missing" in snap).toBe(false);
		if (!("missing" in snap)) {
			expect(snap.pull_requests).toHaveLength(2);
		}
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (String(input) === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			return new Response(JSON.stringify({ error: { code: "snapshot_missing", message: "n" } }), {
				status: 409,
				headers: { "content-type": "application/json" },
			});
		});
		expect(await loadPulls()).toEqual({ missing: true });
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
		await expect(loadPulls()).rejects.toMatchObject({ code: "github_error" });
	});
});
