import { expect, test } from "@playwright/test";
import { factoryFixture } from "../fixtures/factory-snapshot";
import { createUiFixtures } from "./ui-fixtures";

const pages = [
	["/", "仓库"],
	["/factory", "软件工厂"],
	["/insights", "Insights"],
	["/ci", "CI 与发布"],
	["/issues", "Issues"],
	["/pulls", "Pull Requests"],
	["/alerts", "安全告警"],
	["/inbox", "通知"],
] as const;

for (const width of [1440, 390]) {
	test(`page headers keep repository scope beside the title at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 1000 });
		await page.emulateMedia({ reducedMotion: "reduce" });
		const fixtures: Record<string, unknown> = createUiFixtures();
		fixtures["/api/factory"] = { ...factoryFixture(), account_id: "ui-account" };
		fixtures["/api/issues"] = { ...createUiFixtures()["/api/issues"], truncated: true };
		const writes: string[] = [];
		await page.route("**/api/**", (route) => {
			const request = route.request();
			if (request.method() !== "GET") writes.push(request.url());
			const body = fixtures[new URL(request.url()).pathname];
			return body
				? route.fulfill({ json: body })
				: route.fulfill({
						status: 409,
						json: { error: { code: "snapshot_missing", message: "No fixture" } },
					});
		});
		for (const [path, title] of pages) {
			await page.goto(path);
			const header = page
				.locator("header")
				.filter({ has: page.getByRole("heading", { name: title, exact: true }) })
				.last();
			await expect(header.getByText("数据更新", { exact: false }).first()).toBeVisible();
			await expect(header.getByRole("group", { name: "仓库范围", exact: true })).toBeVisible();
			const position = await header.evaluate((element) => {
				const title = element.querySelector("h1")?.getBoundingClientRect();
				const scope = element.querySelector("fieldset")?.getBoundingClientRect();
				return title && scope
					? {
							titleTop: title.top,
							titleBottom: title.bottom,
							titleRight: title.right,
							scopeTop: scope.top,
							scopeBottom: scope.bottom,
							scopeLeft: scope.left,
						}
					: null;
			});
			expect(position, path).not.toBeNull();
			expect(position?.scopeTop, path).toBeLessThan(position?.titleBottom ?? 0);
			expect(position?.scopeBottom, path).toBeGreaterThan(position?.titleTop ?? 0);
			expect(position?.scopeLeft, path).toBeGreaterThanOrEqual(position?.titleRight ?? 0);
			if (width === 1440) {
				const bands = await header
					.locator("p")
					.first()
					.evaluate((element) => {
						const description = element
							.querySelector(":scope > span > span")
							?.getBoundingClientRect();
						const time = element.querySelector("time")?.getBoundingClientRect();
						return description && time
							? {
									descriptionTop: description.top,
									descriptionBottom: description.bottom,
									timeTop: time.top,
									timeBottom: time.bottom,
								}
							: null;
					});
				expect(bands, path).not.toBeNull();
				expect(bands?.timeTop, path).toBeLessThan(bands?.descriptionBottom ?? 0);
				expect(bands?.timeBottom, path).toBeGreaterThan(bands?.descriptionTop ?? 0);
			}
			expect(
				await page.locator("body").evaluate((element) => element.scrollWidth),
				path,
			).toBeLessThanOrEqual(width);
		}
		await page.goto("/insights");
		await page.getByRole("button", { name: "来源数据时间", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "来源数据更新时间" })).toContainText(
			"PR 数据更新",
		);
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog", { name: "来源数据更新时间" })).toHaveCount(0);
		expect(writes).toEqual([]);
	});
}

for (const width of [1440, 1024, 390]) {
	test(`mixed timestamps stay readable in compact dark headers at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
		const fixtures: Record<string, unknown> = createUiFixtures();
		const ci = createUiFixtures()["/api/ci"];
		fixtures["/api/ci"] = {
			...ci,
			freshness: {
				oldestAt: "2026-10-01T00:01:00.000Z",
				latestAt: "2026-10-01T00:54:00.000Z",
				total: 45,
				missing: 3,
			},
		};
		await page.route("**/api/**", (route) => {
			const body = fixtures[new URL(route.request().url()).pathname];
			return body
				? route.fulfill({ json: body })
				: route.fulfill({
						status: 409,
						json: { error: { code: "snapshot_missing", message: "No fixture" } },
					});
		});
		await page.goto("/ci");
		const header = page.locator("header:has(.giraffe-page-title)");
		await expect(header).toContainText("3/45 项缺少数据");
		await expect(header.getByRole("group", { name: "仓库范围", exact: true })).toBeVisible();
		expect(await header.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);
		if (width === 1440) expect((await header.boundingBox())?.height).toBeLessThanOrEqual(64);
	});
}
