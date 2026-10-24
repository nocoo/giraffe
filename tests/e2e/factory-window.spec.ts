import { expect, test } from "@playwright/test";
import { factoryWindow } from "../../apps/web/src/lib/factory";
import { factoryFixture } from "../fixtures/factory-snapshot";
import { createUiFixtures, projectFactoryFixture } from "./ui-fixtures";

for (const dayCount of [30, 90]) {
	test(`factory and repository labels follow the ${dayCount}-day observation`, async ({ page }) => {
		const snapshot = factoryFixture();
		snapshot.account_id = "ui-account";
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		repo.name = "octocat/hello-world";
		repo.observation = {
			version: snapshot.runId,
			window: factoryWindow(snapshot.fetched_at, dayCount),
			refreshedAt: snapshot.fetched_at,
			source: "run",
		};
		snapshot.window = factoryWindow(snapshot.fetched_at, 30);
		const fixtures: Record<string, unknown> = {
			...createUiFixtures(),
			"/api/factory": projectFactoryFixture(snapshot),
		};
		await page.route("**/api/**", (route) => {
			const pathname = new URL(route.request().url()).pathname;
			return pathname in fixtures
				? route.fulfill({ json: fixtures[pathname] })
				: route.fulfill({
						status: 409,
						json: { error: { code: "snapshot_missing", message: "No fixture" } },
					});
		});
		await page.goto("/factory");
		await expect(page.getByRole("heading", { name: `变化 · 最近 ${dayCount} 天` })).toBeVisible();
		await page.locator("#factory-change-title").getByLabel("More information").hover();
		await expect(page.getByRole("tooltip")).toContainText(
			"每日快速刷新 30 天，每周深度刷新校准 90 天",
		);
		await expect(page.getByRole("tooltip")).toContainText("默认 7 天仅用于期间比较");
		const methodology = page.locator("details").filter({ hasText: "来源、口径与不确定性" });
		await methodology.locator(":scope > summary").click();
		await expect(methodology).toHaveAttribute("open", "");
		await expect(
			methodology.getByText("历史总量与观测窗口内流量分开", { exact: false }),
		).toBeVisible();
		await expect(methodology).not.toContainText(/历史总量与\s*90\s*天流量分开/);
		await page.goto("/repos/octocat/hello-world");
		await expect(
			page.getByRole("heading", { name: `${dayCount} 天活动`, exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("group", { name: `仓库 ${dayCount} 天活动`, exact: true }),
		).toBeVisible();
	});
}
