import { expect, type Page, test } from "@playwright/test";
import { NAV_GROUPS } from "../../apps/web/src/client/lib/navigation";
import { APP_VERSION } from "../../apps/web/src/lib/version";
import { factoryFixture } from "../fixtures/factory-snapshot";
import { createUiFixtures, projectFactoryFixture } from "./ui-fixtures";

async function gotoAndWaitForSidebar(page: Page, url: string) {
	await Promise.all([
		page.goto(url),
		page.waitForResponse((response) => response.url().includes("/api/me") && response.ok()),
	]);
}

async function waitForReposRouteSettled(page: Page, width: number) {
	await expect(page).toHaveURL(/\/repos$/);
	await expect(page.getByText("当前账号下的仓库快照")).toBeVisible();
	const sidebar = page.getByRole("complementary");
	if (width === 1440) {
		await expect(sidebar.getByRole("button", { name: "展开侧栏" })).toBeVisible();
		await expect(sidebar.getByRole("button", { name: /搜索/ })).toBeVisible();
		await expect(sidebar.getByRole("button", { name: "仓库", exact: true })).toHaveAttribute(
			"aria-current",
			"page",
		);
	} else {
		await expect(page.getByRole("dialog", { name: "打开导航" })).toBeHidden();
	}
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			}),
	);
}

function stubApi(page: Page, fixtures: Record<string, unknown>, writes: string[]) {
	return page.route("**/api/**", (route) => {
		const request = route.request();
		if (request.method() !== "GET") writes.push(request.url());
		const path = new URL(request.url()).pathname;
		if (path.startsWith("/api/agent/accounts/")) {
			return route.fulfill({
				json: {
					account_id: "ui-account",
					items: [],
					repositories: [],
					sources: [],
					invalidCount: 0,
				},
			});
		}
		return path in fixtures
			? route.fulfill({ json: fixtures[path] })
			: route.fulfill({
					status: 409,
					json: { error: { code: "snapshot_missing", message: "No fixture" } },
				});
	});
}

for (const width of [1440, 390]) {
	for (const theme of ["light", "dark"] as const) {
		test(`factory landing and AI navigation at ${width}px in ${theme}`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
			const fixtures: Record<string, unknown> = createUiFixtures();
			fixtures["/api/factory"] = projectFactoryFixture({
				...factoryFixture(),
				account_id: "ui-account",
			});
			const writes: string[] = [];
			await stubApi(page, fixtures, writes);

			await gotoAndWaitForSidebar(page, "/");
			await expect(page).toHaveURL(/\/factory$/);
			await expect(page.getByRole("heading", { name: "软件工厂", exact: true })).toBeVisible();
			if (width === 390) await page.getByRole("button", { name: "打开导航" }).click();
			const sidebar = page.getByRole("complementary");
			const nav = sidebar.getByRole("navigation");
			await expect(nav.locator("button:not([aria-expanded])").first()).toHaveText("软件工厂");
			await expect(nav.locator("[aria-current=page]")).toHaveText("软件工厂");
			await expect(nav.locator("button[aria-expanded]")).toHaveText(
				NAV_GROUPS.map((group) => group.label),
			);
			const aiToggle = nav.getByRole("button", { name: "AI", exact: true });
			const ai = page.locator(`[id="${await aiToggle.getAttribute("aria-controls")}"]`);
			await expect(ai.getByRole("button")).toHaveText(["分析台", "Insights"]);
			await expect(nav.getByRole("button", { name: "Agent", exact: true })).toHaveCount(0);
			await aiToggle.click();
			await expect(aiToggle).toHaveAttribute("aria-expanded", "false");
			await expect(ai.getByRole("button", { name: "分析台", exact: true })).toBeHidden();
			await aiToggle.focus();
			await page.keyboard.press("Enter");
			await expect(aiToggle).toHaveAttribute("aria-expanded", "true");
			await expect(ai.getByRole("button", { name: "分析台", exact: true })).toBeVisible();
			const home = sidebar.getByRole("link", { name: "Giraffe 首页" });
			await expect(home).toHaveAttribute("href", "/");
			await expect(home.getByText(`v${APP_VERSION}`, { exact: true })).toBeVisible();
			await expect(sidebar.getByText(`v${APP_VERSION}`, { exact: true })).toHaveCount(1);
			const expandedLogo = await home.locator("img").boundingBox();
			expect(expandedLogo?.width).toBe(28);
			const headerNode = await page.locator("[data-basalt-header]").elementHandle();
			const mainNode = await page.locator("main").elementHandle();
			const sidebarNode = width === 1440 ? await sidebar.elementHandle() : null;
			const documents: string[] = [];
			page.on("request", (request) => {
				if (request.resourceType() === "document") documents.push(request.url());
			});

			for (const [label, path] of [
				["分析台", "/analysis"],
				["Insights", "/insights"],
				["仓库", "/repos"],
			] as const) {
				await nav.getByRole("button", { name: label, exact: true }).click();
				await expect(page).toHaveURL(new RegExp(`${path}$`));
				await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
				expect(
					await headerNode?.evaluate(
						(node) => node === document.querySelector("[data-basalt-header]"),
					),
				).toBe(true);
				expect(await mainNode?.evaluate((node) => node === document.querySelector("main"))).toBe(
					true,
				);
				if (width === 390) {
					await expect(page.getByRole("dialog", { name: "打开导航" })).toBeHidden();
					await page.getByRole("button", { name: "打开导航" }).click();
				}
				await expect(nav.locator("[aria-current=page]")).toHaveText(label);
			}

			if (width === 390) await page.keyboard.press("Escape");
			else await sidebar.getByRole("button", { name: "折叠侧栏" }).click();
			if (width === 1440) {
				const collapsedLogo = await home.locator("img").boundingBox();
				expect(collapsedLogo?.x).toBe(expandedLogo?.x);
				expect(collapsedLogo?.y).toBe(expandedLogo?.y);
				await expect(sidebar.getByText(`v${APP_VERSION}`, { exact: true })).toHaveCount(0);
				await expect(nav.getByRole("button").first()).toHaveAccessibleName("搜索 (⌘K)");
			}
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
			await waitForReposRouteSettled(page, width);
			expect(documents).toEqual([]);
			if (width === 1440) {
				await expect(sidebar.getByRole("button", { name: "展开侧栏" })).toBeVisible();
				expect(await sidebarNode?.evaluate((node) => node.isConnected)).toBe(true);
			}
			if (width === 390) {
				await page.getByRole("button", { name: "打开导航" }).click();
				await expect(nav.locator("[aria-current=page]")).toHaveText("仓库");
			}
			await page.keyboard.press("ControlOrMeta+k");
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

test("command palette opens from collapsed sidebar search control", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
	const fixtures: Record<string, unknown> = createUiFixtures();
	fixtures["/api/factory"] = projectFactoryFixture({
		...factoryFixture(),
		account_id: "ui-account",
	});
	const writes: string[] = [];
	await stubApi(page, fixtures, writes);

	await gotoAndWaitForSidebar(page, "/repos");
	await expect(page).toHaveURL(/\/repos$/);
	const sidebar = page.getByRole("complementary");
	await sidebar.getByRole("button", { name: "折叠侧栏" }).click();
	await waitForReposRouteSettled(page, 1440);
	await sidebar.getByRole("button", { name: /搜索/ }).click();
	await expect(page.getByPlaceholder("搜索页面或仓库")).toBeVisible();
	expect(writes).toEqual([]);
});

test("group disclosure stays collapsed when another group navigates", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const writes: string[] = [];
	await stubApi(page, createUiFixtures(), writes);
	await gotoAndWaitForSidebar(page, "/repos");
	const sidebar = page.getByRole("complementary");
	const ai = sidebar.getByRole("button", { name: "AI", exact: true });
	await ai.click();
	await expect(ai).toHaveAttribute("aria-expanded", "false");
	await sidebar.getByRole("button", { name: "Issues", exact: true }).click();
	await expect(page).toHaveURL(/\/issues$/);
	await expect(page.getByRole("heading", { name: "Issues", exact: true })).toBeVisible();
	await expect(ai).toHaveAttribute("aria-expanded", "false");
	expect(writes).toEqual([]);
});

test("mobile navigation restores focus and closes across the desktop breakpoint", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 900 });
	const writes: string[] = [];
	await stubApi(page, createUiFixtures(), writes);
	await page.goto("/repos");
	await expect(page.getByText("当前账号下的仓库快照")).toBeVisible();
	const opener = page.getByRole("button", { name: "打开导航" });
	await opener.click();
	const drawer = page.getByRole("dialog", { name: "打开导航" });
	await expect(drawer).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(drawer).toBeHidden();
	await expect(opener).toBeFocused();
	await opener.click();
	await expect(drawer).toBeVisible();
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(drawer).toBeHidden();
	await expect(page.getByRole("complementary")).toHaveCount(1);
	await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
	await page.setViewportSize({ width: 390, height: 900 });
	await expect(drawer).toBeHidden();
	await expect(opener).toBeVisible();
	expect(writes).toEqual([]);
});
