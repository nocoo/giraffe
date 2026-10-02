import { beforeEach, expect, it, vi } from "vitest";
import { apiGet, apiPost } from "../lib/api";
import { loadAnalysis, requestAnalysis } from "./analysis";
import { setActiveAccountId } from "./session";

vi.mock("../lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
beforeEach(() => {
	vi.clearAllMocks();
	setActiveAccountId("a");
});
it("loads all cursor pages with fixed account and submits explicit scoped requests", async () => {
	vi.mocked(apiGet).mockImplementation(async (path) =>
		path === "accounts"
			? { accounts: [{ id: "a", is_active: true }] }
			: path.includes("/sources")
				? { account_id: "a", sources: [], repositories: [] }
				: { account_id: "a", items: [], nextCursor: path.includes("cursor=") ? null : "next" },
	);
	expect(await loadAnalysis()).toMatchObject({
		account_id: "a",
		reports: [],
		records: [],
		jobs: [],
		sources: [],
		repositories: [],
	});
	await requestAnalysis("a", null, ["ci"]);
	expect(apiPost).toHaveBeenCalledWith("agent/accounts/a/jobs", {
		type: "analysis-request",
		status: "pending",
		repository: null,
		payload: { scope: "global", repository: null, domains: ["ci"] },
	});
	await requestAnalysis("a", "nocoo/app", ["prs"]);
	expect(apiPost).toHaveBeenLastCalledWith(
		"agent/accounts/a/jobs",
		expect.objectContaining({ repository: "nocoo/app" }),
	);
	setActiveAccountId("other");
	await expect(requestAnalysis("a", null, ["ci"])).rejects.toThrow("Account changed");
});
it("rejects account changes and invalid or excessive cursor traversal", async () => {
	for (const mode of ["account", "repeat", "limit", "source"]) {
		let cursor = 0;
		vi.mocked(apiGet).mockImplementation(async (path) =>
			path === "accounts"
				? { accounts: [{ id: "a", is_active: true }] }
				: path.includes("/sources")
					? { account_id: mode === "source" ? "b" : "a", sources: [], repositories: [] }
					: {
							account_id: mode === "account" ? "b" : "a",
							items: [],
							nextCursor: mode === "repeat" ? "same" : mode === "limit" ? String(++cursor) : null,
						},
		);
		await expect(loadAnalysis()).rejects.toThrow();
	}
});
