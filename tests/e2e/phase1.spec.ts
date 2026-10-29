import { expect, test } from "@playwright/test";
import { createUiFixtures } from "./ui-fixtures";

test("analysis stays retired and restored refresh never executes the deleted stack", async ({
	page,
}) => {
	const requests: string[] = [];
	const fixtures: Record<string, unknown> = createUiFixtures();
	fixtures["/api/tokens"] = { account_id: "ui-account", items: [] };
	await page.route("**/api/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		requests.push(path);
		return path in fixtures
			? route.fulfill({ json: fixtures[path] })
			: route.fulfill({
					status: 409,
					json: { error: { code: "snapshot_missing", message: "No saved fixture" } },
				});
	});
	await page.goto("/analysis");
	await expect(page.getByText("页面不存在", { exact: true })).toBeVisible();
	await page.goto("/refresh");
	await expect(page.getByRole("heading", { name: "刷新中心", exact: true })).toBeVisible();
	await expect(page.getByRole("tab", { name: /快速|深度|完整/ })).toHaveCount(0);
	await page.goto("/repos/octocat/hello-world?tab=analysis");
	await expect(page.getByTestId("repo-detail")).toBeVisible();
	await expect(page.getByRole("tab", { name: "Agent 分析", exact: true })).toHaveCount(0);
	await expect(page.getByRole("link", { name: /分析台/ })).toHaveCount(0);
	await page.goto("/settings");
	await expect(page.getByText("外部 Bot API 令牌", { exact: true })).toBeVisible();
	expect(
		requests.filter((path) => /^\/api\/(refresh|factory\/runs|agent)(\/|$)/.test(path)),
	).toEqual([]);
	await page.getByRole("button", { name: /搜索/ }).first().click();
	await expect(page.getByPlaceholder("搜索页面或仓库")).toBeVisible();
	await expect(page.getByRole("option", { name: /分析台/ })).toHaveCount(0);
	await expect(page.getByRole("option", { name: /刷新中心/ })).toHaveCount(1);
});
