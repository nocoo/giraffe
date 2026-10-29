import { expect, test } from "@playwright/test";
import { emptyDay } from "../../apps/web/src/lib/factory";
import { factoryFixture, savedFactoryWindow } from "../fixtures/factory-snapshot";
import { createUiFixtures, projectFactoryFixture } from "./ui-fixtures";
import { uiRefreshReviewFixtures } from "./ui-refresh-review-fixtures";

test("factory ranges end at saved Shanghai data and keep unobserved days empty", async ({
	page,
}) => {
	const fixtures = uiRefreshReviewFixtures();
	await page.route("**/api/**", (route) => {
		const pathname = new URL(route.request().url()).pathname;
		return route.fulfill({
			json: fixtures[pathname] ?? { error: { code: "snapshot_missing", message: "No fixture" } },
			status: pathname in fixtures ? 200 : 409,
		});
	});
	await page.goto("/factory");
	const range = page.getByRole("radiogroup", { name: "图表窗口", exact: true });
	await expect(range.getByRole("radio", { name: "90 天", exact: true })).toBeChecked();
	await expect(page.locator("button.factory-day")).toHaveCount(90);
	await expect(page.getByRole("heading", { name: "变化 · 最近 90 天", exact: true })).toBeVisible();
	const latest = page.locator("button.factory-day").last();
	await expect(latest).toHaveAttribute("aria-label", /2026-10-22.*Asia\/Shanghai/);
	await expect(page.locator("button.factory-day").first()).toHaveAttribute("aria-label", /无观测/);
	await range.getByRole("radio", { name: "30 天", exact: true }).click();
	await expect(page).toHaveURL(/range=30/);
	await expect(page.getByRole("heading", { name: "变化 · 最近 30 天", exact: true })).toBeVisible();
	await expect(page.locator("button.factory-day")).toHaveCount(30);
	await range.getByRole("radio", { name: "180 天", exact: true }).click();
	await expect(page.locator("button.factory-day")).toHaveCount(180);
	await expect(latest).toHaveAttribute("aria-label", /2026-10-22.*Asia\/Shanghai/);
	await range.getByRole("radio", { name: "90 天", exact: true }).click();
	await expect(page.locator("button.factory-day")).toHaveCount(90);
});

for (const dayCount of [30, 90]) {
	test(`factory and repository labels follow the ${dayCount}-day observation`, async ({ page }) => {
		const snapshot = factoryFixture();
		snapshot.account_id = "ui-account";
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		repo.name = "octocat/hello-world";
		repo.metrics.days = { "2026-09-15": emptyDay() };
		repo.observation = {
			version: snapshot.runId,
			window: savedFactoryWindow(snapshot.fetched_at, dayCount),
			refreshedAt: snapshot.fetched_at,
			source: "run",
		};
		repo.coverage.commits.status = "partial";
		repo.coverage.commits.completeWindows = [repo.observation.window];
		snapshot.window = savedFactoryWindow(snapshot.fetched_at, 30);
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
		await expect(page.getByRole("heading", { name: "变化 · 最近 90 天" })).toBeVisible();
		await expect(page.locator("button.factory-day")).toHaveCount(90);
		await expect(page.getByText("提交尚未采集。", { exact: true })).toHaveCount(0);
		await page.locator("#factory-change-title").getByLabel("More information").hover();
		await expect(page.getByRole("tooltip")).not.toContainText("快速刷新");
		await expect(page.getByRole("tooltip")).not.toContainText("深度刷新");
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
