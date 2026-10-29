import { expect, test } from "@playwright/test";

test("a fresh account keeps the dashboard and cannot start collection", async ({ page }) => {
	const collectionRequests: string[] = [];
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (/^\/api\/(refresh|factory\/runs|agent)(\/|$)/.test(path)) {
			collectionRequests.push(`${request.method()} ${path}`);
		}
	});
	await page.goto("/settings");
	await page.getByTestId("pat-input").fill(`ghp_${"A".repeat(36)}`);
	await page.getByTestId("pat-submit").click();
	await expect(page.getByTestId("pat-input")).toHaveValue("");
	await expect(page.locator("form").filter({ has: page.getByTestId("pat-input") })).toHaveAttribute(
		"aria-busy",
		"false",
	);
	await page.goto("/factory");
	await expect(page.getByRole("heading", { name: "软件工厂", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "刷新暂不可用", exact: true })).toBeDisabled();
	await expect(page.getByText("暂无已保存的快照", { exact: true })).toBeVisible();
	await expect(page.getByText(/旧刷新已停用/)).toBeVisible();
	await expect(page.getByRole("link", { name: /去刷新|刷新中心/ })).toHaveCount(0);
	for (const title of [
		"变化 · 暂无观测窗口",
		"提交产出与覆盖面",
		"交付吞吐",
		"PR 流量与存量",
		"Issue 流量与存量",
		"仓库变化矩阵",
		"存量 · 我名下全部仓库",
		"提交日历",
		"积压任务",
		"仓库规模地图",
		"提交与待办",
		"工作流量账",
		"需要检查的信号",
		"依赖与维护",
		"仓库生产线 · 按窗口提交量排序",
	])
		await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
	await expect(page.locator(".giraffe-stat-card")).toHaveCount(5);
	await expect(page.getByRole("table", { name: "仓库生产线", exact: true })).toBeVisible();
	await expect(page.getByRole("columnheader", { name: "资源覆盖", exact: true })).toBeVisible();
	await expect(page.locator(".factory-period dd")).toHaveText(["—", "—", "—", "—", "—"]);
	await expect(page.locator("main time")).toHaveCount(0);
	await expect(page.locator("main")).not.toContainText(/最近 \d+ 天|\d{4}-\d{2}-\d{2}|0 个|0%/);
	for (const path of [
		"/repos",
		"/issues",
		"/pulls",
		"/ci",
		"/alerts",
		"/inbox",
		"/today",
		"/insights",
	]) {
		await page.goto(path);
		await expect(page.locator("main")).toBeVisible();
		await expect(page.getByText("页面不存在", { exact: true })).toHaveCount(0);
	}
	expect(collectionRequests).toEqual([]);
});
