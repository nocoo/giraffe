import { beforeEach, expect, it, vi } from "vitest";
import { apiGet, apiPost } from "../lib/api";
import { loadAnalysis } from "./analysis";
import { setActiveAccountId } from "./session";

vi.mock("../lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
beforeEach(() => {
	vi.clearAllMocks();
	setActiveAccountId("a");
});
it("loads one report projection without generic report pagination or execution requests", async () => {
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
		sources: [],
		repositories: [],
	});
	expect(apiPost).not.toHaveBeenCalled();
	const paths = vi.mocked(apiGet).mock.calls.map(([path]) => path);
	expect(paths.filter((path) => path.includes("/reports"))).toEqual([
		"agent/accounts/a/analysis/reports",
	]);
	expect(paths.filter((path) => path.includes("/records"))).toEqual([
		"agent/accounts/a/records?limit=100&type=grok-bot-run",
		"agent/accounts/a/records?limit=100&type=grok-bot-run&cursor=next",
	]);
	expect(paths.some((path) => path.includes("/jobs") || path.includes("work-cron"))).toBe(false);
});
it("rejects account changes and invalid or excessive cursor traversal", async () => {
	for (const mode of ["account", "repeat", "limit", "source", "report"]) {
		let cursor = 0;
		vi.mocked(apiGet).mockImplementation(async (path) =>
			path === "accounts"
				? { accounts: [{ id: "a", is_active: true }] }
				: path.includes("/sources")
					? { account_id: mode === "source" ? "b" : "a", sources: [], repositories: [] }
					: {
							account_id:
								mode === "account" || (mode === "report" && path.includes("/analysis/reports"))
									? "b"
									: "a",
							items: [],
							nextCursor: mode === "repeat" ? "same" : mode === "limit" ? String(++cursor) : null,
						},
		);
		await expect(loadAnalysis()).rejects.toThrow();
	}
});
