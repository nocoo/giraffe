// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { categoryLabel, loadRepoMeta } from "./repo-meta";
import { setActiveAccountId } from "./session";

afterEach(() => {
	setActiveAccountId(null);
	vi.unstubAllGlobals();
});
it("R6 reads metadata through the account-fenced browser route and rejects invalid repository parts", async () => {
	const calls: string[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
		calls.push(String(input));
		return Response.json(
			String(input) === "/api/accounts"
				? { accounts: [{ id: "a", is_active: true }] }
				: { account_id: "a", created_at: "2026-01-01T00:00:00Z", category: "docs-vault" },
		);
	});
	expect(await loadRepoMeta("owner", "app")).toMatchObject({
		account_id: "a",
		category: "docs-vault",
	});
	expect(calls).toEqual(["/api/accounts", "/api/repos/owner/app/meta"]);
	expect(await loadRepoMeta("..", "app")).toEqual({ missing: true });
	expect(await loadRepoMeta("owner", "..")).toEqual({ missing: true });
	for (const [code, status] of [
		["not_found", 404],
		["db_error", 500],
	] as const) {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
			String(input) === "/api/accounts"
				? Response.json({ accounts: [{ id: "a", is_active: true }] })
				: Response.json({ error: { code, message: "Unavailable" } }, { status }),
		);
		if (status === 404) expect(await loadRepoMeta("owner", "app")).toEqual({ missing: true });
		else await expect(loadRepoMeta("owner", "app")).rejects.toMatchObject({ status: 500 });
	}
});
it("R6 presents every documented category and an explicit empty value", () => {
	expect(
		["app", "docs-vault", "profile", "repro", "derivative", null].map((category) =>
			categoryLabel(category),
		),
	).toEqual(["应用", "文档库", "个人主页", "问题复现", "衍生项目", "未分类"]);
	expect(categoryLabel("unknown")).toBe("未分类");
});
