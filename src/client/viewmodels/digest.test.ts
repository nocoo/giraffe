// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDelta } from "../lib/format";
import { digestMarkdown, loadDigest } from "./digest";
import { setActiveAccountId } from "./session";
import { clearSnapshots } from "./snapshot";

const withBaseline = {
	account_id: "acc1",
	fetched_at: "t",
	truncated: false,
	day: "2026-09-01",
	baseline_missing: false,
	stars_delta: 3,
	forks_delta: 0,
	open_issues_delta: -1,
	repos: [
		{
			name_with_owner: "octocat/hello-world",
			stars_delta: 3,
			forks_delta: 0,
			open_issues_delta: -1,
		},
	],
};

const missingBaseline = {
	...withBaseline,
	baseline_missing: true,
	stars_delta: null,
	forks_delta: null,
	open_issues_delta: null,
	repos: [
		{
			name_with_owner: "octocat/hello-world",
			stars_delta: null,
			forks_delta: null,
			open_issues_delta: null,
		},
	],
};

describe("digest viewmodel", () => {
	afterEach(() => {
		setActiveAccountId(null);
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("renders markdown without fake zeros when baseline is missing", () => {
		expect(formatDelta(null, false)).toBe("—");
		expect(formatDelta(2, false)).toBe("2");
		expect(formatDelta(0, true)).toBe("—");
		const md = digestMarkdown(missingBaseline);
		expect(md).toContain("没有昨天的基线");
		expect(md).toContain("—");
		expect(md).not.toContain("| 0 |");
		expect(md).not.toContain("合计 stars 0");
		const present = digestMarkdown(withBaseline);
		expect(present).toContain("| octocat/hello-world | 3 | 0 | -1 |");
		expect(present).toContain("合计 stars 3 / forks 0 / issues -1");
		expect(present).not.toContain("没有昨天的基线");
	});

	it("loads digest after session and maps snapshot_missing", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/accounts") {
				return Response.json({ accounts: [{ id: "acc1", login: "o", is_active: true }] });
			}
			if (url === "/api/digest") {
				return Response.json(withBaseline);
			}
			throw new Error(url);
		});
		const snap = await loadDigest();
		expect("missing" in snap).toBe(false);
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
		expect(await loadDigest()).toEqual({ missing: true });
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
		await expect(loadDigest()).rejects.toMatchObject({ code: "github_error" });
	});
});
