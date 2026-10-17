import { expect, test } from "@playwright/test";
import { factoryFixture } from "../fixtures/factory-snapshot";
import { createUiFixtures } from "./ui-fixtures";

for (const width of [1440, 390]) {
	for (const theme of ["light", "dark"] as const) {
		test(`factory landing and AI navigation at ${width}px in ${theme}`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
			const fixtures: Record<string, unknown> = createUiFixtures();
			fixtures["/api/factory"] = { ...factoryFixture(), account_id: "ui-account" };
			const writes: string[] = [];
			await page.route("**/api/**", (route) => {
				const request = route.request();
				if (request.method() !== "GET") writes.push(request.url());
				const path = new URL(request.url()).pathname;
				if (path.startsWith("/api/agent/accounts/")) {
					return route.fulfill({
						json: { account_id: "ui-account", items: [], repositories: [], sources: [] },
					});
				}
				return path in fixtures
					? route.fulfill({ json: fixtures[path] })
					: route.fulfill({
							status: 409,
							json: { error: { code: "snapshot_missing", message: "No fixture" } },
						});
			});

			await page.goto("/");
			await expect(page).toHaveURL(/\/factory$/);
			await expect(page.getByRole("heading", { name: "软件工厂", exact: true })).toBeVisible();
			if (width === 390) await page.getByRole("button", { name: "打开导航" }).click();
			const sidebar = page.getByRole("complementary");
			const nav = sidebar.getByRole("navigation");
			await expect(nav.getByRole("button").first()).toHaveText("软件工厂");
			await expect(nav.locator("[aria-current=page]")).toHaveText("软件工厂");
			const ai = nav.locator(":scope > div").filter({ has: page.getByText("AI", { exact: true }) });
			await expect(ai.getByRole("button")).toHaveText(["分析台", "Agent", "Insights"]);

			for (const [label, path] of [
				["分析台", "/analysis"],
				["Agent", "/work"],
				["Insights", "/insights"],
				["仓库", "/repos"],
			] as const) {
				await nav.getByRole("button", { name: label, exact: true }).click();
				await expect(page).toHaveURL(new RegExp(`${path}$`));
				await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
				if (width === 390) {
					await expect(page.getByRole("dialog", { name: "打开导航" })).toBeHidden();
					await page.getByRole("button", { name: "打开导航" }).click();
				}
				await expect(nav.locator("[aria-current=page]")).toHaveText(label);
			}

			if (width === 390) await page.keyboard.press("Escape");
			else await sidebar.getByRole("button", { name: "折叠侧栏" }).click();
			await page
				.getByTestId("repo-list")
				.getByRole("link", { name: "octocat/hello-world" })
				.click();
			await expect(page).toHaveURL(/\/repos\/octocat\/hello-world$/);
			if (width === 1440) {
				await expect(nav.getByRole("button", { name: "仓库", exact: true })).toHaveAttribute(
					"aria-current",
					"page",
				);
			}
			await page.locator("header").getByRole("link", { name: "仓库", exact: true }).click();
			await expect(page).toHaveURL(/\/repos$/);
			if (width === 390) await page.getByRole("button", { name: "打开导航" }).click();
			await page.getByRole("button", { name: /搜索/ }).click();
			const search = page.getByPlaceholder("搜索页面或仓库");
			await expect(search).toBeVisible();
			await search.fill("软件工厂");
			await expect(page.getByRole("option", { name: "软件工厂", exact: true })).toBeVisible();
			await page.keyboard.press("Enter");
			await expect(page).toHaveURL(/\/factory$/);
			await page.goBack();
			await expect(page).toHaveURL(/\/repos$/);
			expect(
				await page.locator("body").evaluate((element) => element.scrollWidth),
			).toBeLessThanOrEqual(width);
			expect(writes).toEqual([]);
		});
	}
}
