import { beforeEach, expect, it, vi } from "vitest";
import { apiGet, apiPost } from "../lib/api";
import { loadAnalysis } from "./analysis";
import { setActiveAccountId } from "./session";

vi.mock("../lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
beforeEach(() => {
	vi.clearAllMocks();
	setActiveAccountId("a");
});
it("loads all report pages without redundant execution requests", async () => {
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
	expect(apiPost).not.toHaveBeenCalled();
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
