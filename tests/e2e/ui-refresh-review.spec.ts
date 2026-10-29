import { expect, type Page, test } from "@playwright/test";
import { uiRefreshReviewFixtures } from "./ui-refresh-review-fixtures";

async function expectDimensionChipsFit(page: Page) {
	const chips = page.locator(".refresh-mini-dims > span");
	expect(await chips.allTextContents()).toEqual(
		expect.arrayContaining(["提交", "Issues", "PRs", "CI", "发布", "告警"]),
	);
	const measured = await chips.evaluateAll((nodes) =>
		nodes.map((node) => ({
			label: node.textContent ?? "",
			overflow: node.scrollWidth - node.clientWidth,
		})),
	);
	expect(measured.filter((chip) => chip.overflow > 0)).toEqual([]);
	const rowOverflow = await page
		.locator(".refresh-run-row > summary")
		.evaluateAll((nodes) => nodes.map((node) => node.scrollWidth - node.clientWidth));
	expect(rowOverflow.filter((delta) => delta > 0)).toEqual([]);
}

for (const viewport of [
	{ width: 1440, height: 1100 },
	{ width: 390, height: 844 },
]) {
	for (const theme of ["light", "dark"] as const) {
		test(`UI refresh review ${theme} ${viewport.width}px`, async ({ page }, info) => {
			await page.setViewportSize(viewport);
			await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
			await page.clock.setFixedTime(new Date("2026-10-23T01:01:20.000Z"));
			const fixtures = uiRefreshReviewFixtures();
			const writes: string[] = [];
			await page.route("**/api/**", (route) => {
				const request = route.request();
				const pathname = new URL(request.url()).pathname;
				if (request.method() !== "GET") {
					writes.push(pathname);
					return route.fulfill({
						status: 403,
						json: { error: { code: "fixture_read_only", message: "Read-only screenshot fixture" } },
					});
				}
				return pathname in fixtures
					? route.fulfill({ json: fixtures[pathname] })
					: route.fulfill({
							status: 409,
							json: { error: { code: "snapshot_missing", message: "No fixture" } },
						});
			});
			for (const [path, title] of [
				["today", "今日活动"],
				["settings", "设置"],
				["factory", "软件工厂"],
				["refresh", "刷新中心"],
			]) {
				await page.goto(`/${path}`);
				if (path === "refresh" && process.env.GIRAFFE_UI_BASELINE === "1") {
					await expect(page.getByText("页面不存在", { exact: true })).toBeVisible();
				} else {
					await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
				}
				await expect(page.getByText("正在加载页面…", { exact: true })).toHaveCount(0);
				if (path === "settings") {
					await expect(page.getByRole("textbox", { name: "Daily digest bot 标签" })).toBeAttached();
					await page.getByText("外部 Bot API 令牌", { exact: true }).scrollIntoViewIfNeeded();
				}
				if (path === "today") await expect(page.getByTestId("activity-window")).toBeVisible();
				if (path === "factory")
					await expect(page.getByRole("heading", { name: "提交日历", exact: true })).toBeVisible();
				await page.screenshot({
					path: info.outputPath(`${path}-${theme}-${viewport.width}.png`),
					animations: "disabled",
					fullPage: true,
				});
				if (process.env.GIRAFFE_UI_BASELINE !== "1") {
					if (path === "settings" && viewport.width < 700) {
						const tokenLabel = page.getByRole("textbox", { name: "Daily digest bot 标签" });
						await tokenLabel.scrollIntoViewIfNeeded();
						await expect(tokenLabel).toBeVisible();
						await page.screenshot({
							path: info.outputPath(`settings-tokens-${theme}-${viewport.width}.png`),
							animations: "disabled",
						});
					}
					if (path === "factory" && viewport.width < 700) {
						await page.locator("#factory-change-title").evaluate((node) => {
							node.scrollIntoView({ block: "start" });
							const header = document.querySelector("header")?.getBoundingClientRect().height ?? 0;
							window.scrollBy(0, -header - 8);
						});
						await expect(
							page.getByRole("heading", { name: "提交产出与覆盖面", exact: true }),
						).toBeVisible();
						await page.screenshot({
							path: info.outputPath(`factory-charts-${theme}-${viewport.width}.png`),
							animations: "disabled",
						});
					}
				}
				if (path === "refresh" && process.env.GIRAFFE_UI_BASELINE !== "1") {
					await page.locator('section[aria-label="刷新记录"]').scrollIntoViewIfNeeded();
					await expectDimensionChipsFit(page);
					await page.screenshot({
						path: info.outputPath(`refresh-details-${theme}-${viewport.width}.png`),
						animations: "disabled",
						fullPage: true,
					});
				}
				expect(
					await page.locator("body").evaluate((element) => element.scrollWidth),
					path,
				).toBeLessThanOrEqual(viewport.width);
			}
			expect(writes).toEqual([]);
		});
	}
}
