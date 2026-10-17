import { expect, test } from "@playwright/test";
import { createUiFixtures } from "./ui-fixtures";

for (const width of [1440, 390]) {
	for (const theme of ["light", "dark"] as const) {
		test(`local source switch at ${width}px in ${theme}`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
			await page.addInitScript(() => {
				window.__GIRAFFE_LOCAL__ = {
					mode: "local",
					instanceId: "local-test",
					csrfToken: "csrf-test",
				};
			});
			const fixtures: Record<string, unknown> = createUiFixtures();
			const selections: string[] = [];
			let accept = false;
			await page.route("**/api/**", (route) => {
				const request = route.request();
				const path = new URL(request.url()).pathname;
				expect(request.headers()["x-giraffe-local-instance"]).toBe("local-test");
				if (path === "/api/__local/environment") {
					expect(request.headers()["x-giraffe-local-csrf"]).toBe("csrf-test");
					selections.push(request.postData() ?? "");
					return accept
						? route.fulfill({
								json: { mode: "prod", instanceId: "prod-test", csrfToken: "csrf-test" },
							})
						: route.fulfill({
								status: 401,
								json: {
									error: {
										code: "local_prod_login_required",
										message: "请运行 bun run login:prod 后重试",
									},
								},
							});
				}
				return route.fulfill({ json: fixtures[path] ?? { account_id: "ui-account", items: [] } });
			});
			await page.goto("/settings");
			const local = page.getByRole("radio", { name: "Local", exact: true });
			const prod = page.getByRole("radio", { name: "Prod · 只读", exact: true });
			await expect(local).toBeChecked();
			await prod.click();
			await expect(page.getByRole("alertdialog")).toContainText("未保存的输入将丢弃");
			await page.getByRole("button", { name: "取消", exact: true }).click();
			expect(selections).toEqual([]);
			await expect(page).toHaveURL(/\/settings$/);
			await prod.click();
			await page.getByRole("button", { name: "切换并返回首页" }).click();
			await expect(page.getByRole("alertdialog")).toContainText("bun run login:prod");
			await page.getByRole("button", { name: "知道了" }).click();
			await expect(local).toBeChecked();
			accept = true;
			await prod.click();
			await page.getByRole("button", { name: "切换并返回首页" }).click();
			await expect(page).toHaveURL(/\/factory$/);
			expect(selections).toEqual(['{"mode":"prod"}', '{"mode":"prod"}']);
			expect(
				await page.locator("body").evaluate((element) => element.scrollWidth),
			).toBeLessThanOrEqual(width);
		});
	}
}

test("hosted pages never expose local environment selection", async ({ page }) => {
	const fixtures: Record<string, unknown> = createUiFixtures();
	await page.route("**/api/**", (route) =>
		route.fulfill({ json: fixtures[new URL(route.request().url()).pathname] ?? {} }),
	);
	await page.goto("/settings");
	await expect(page.getByRole("radio", { name: "Local", exact: true })).toHaveCount(0);
	await expect(page.getByRole("radio", { name: "Prod · 只读", exact: true })).toHaveCount(0);
});
