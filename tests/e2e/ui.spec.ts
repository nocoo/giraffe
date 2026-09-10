import { expect, type Page, test } from "@playwright/test";
import { createUiFixtures } from "./ui-fixtures";

async function mockSnapshots(page: Page) {
	const fixtures: Record<string, unknown> = createUiFixtures();
	await page.route("**/api/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		if (route.request().method() !== "GET") {
			return route.fulfill({
				status: 401,
				json: { error: { code: "github_unauthorized", message: "Fixture request rejected" } },
			});
		}
		return path in fixtures
			? route.fulfill({ json: fixtures[path] })
			: route.fulfill({
					status: 409,
					json: { error: { code: "snapshot_missing", message: "No fixture snapshot" } },
				});
	});
}

test.beforeEach(async ({ page }) => {
	await mockSnapshots(page);
});

async function expectChart(page: Page, label: string) {
	const plot = page
		.getByRole("group", { name: label, exact: true })
		.locator("svg.recharts-surface");
	await expect(plot).toBeVisible();
	await expect
		.poll(async () => {
			const bounds = await plot.boundingBox();
			return Math.min(bounds?.width ?? 0, bounds?.height ?? 0);
		})
		.toBeGreaterThan(80);
	return plot;
}

for (const [path, label, list] of [
	["/", "搜索仓库", "repo-list"],
	["/issues", "搜索 Issues", "issue-list"],
	["/pulls", "搜索 Pull Requests", "pr-list"],
] as const) {
	test(`${label}: recover from an empty search without reloading`, async ({ page }) => {
		await page.goto(path);
		await expect(page.getByTestId(list)).toBeVisible();
		const search = page.getByLabel(label, { exact: true });
		await search.fill("no-matching-fixture");
		await expect(page.getByText("没有匹配结果", { exact: true })).toBeVisible();
		await expect(page.getByTestId(list)).toHaveCount(0);
		await page.getByRole("button", { name: "清除搜索", exact: true }).click();
		await expect(search).toHaveValue("");
		await expect(page.getByTestId(list)).toBeVisible();
		await search.fill("hello-world");
		await page.getByRole("button", { name: "清空搜索框", exact: true }).click();
		await expect(search).toHaveValue("");
		await expect(search).toBeFocused();
	});
}

test("digest copies the report content, including totals", async ({ page, context }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.goto("/digest");
	await expect(page.getByTestId("digest-list")).toBeVisible();
	await page.getByRole("button", { name: "Copy", exact: true }).click();
	const copied = await page.evaluate(() => navigator.clipboard.readText());
	expect(copied).toContain("# 2026-09-08");
	expect(copied).toContain("octocat/hello-world");
	expect(copied).toContain("合计 stars +12 / forks +4 / issues −2");
});

test("marking a notification shows progress and applies the returned unread state", async ({
	page,
}) => {
	let finish = () => {};
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const initial = createUiFixtures()["/api/notifications"];
	let requests = 0;
	await page.route("**/api/notifications/read", async (route) => {
		requests += 1;
		await pending;
		await route.fulfill({
			json: {
				...initial,
				notifications: initial.notifications.map((row) => ({
					...row,
					unread: row.id === "1" ? false : row.unread,
				})),
			},
		});
	});
	try {
		await page.goto("/inbox");
		const row = page.getByTestId("inbox-list").getByRole("row").filter({ hasText: "优化长标题" });
		const mark = row.getByRole("button", { name: "标为已读", exact: true });
		await expect(mark).toBeVisible();
		await mark.click();
		await expect(mark).toBeDisabled();
		await expect(page.getByRole("button", { name: "全部已读", exact: true })).toBeDisabled();
		finish();
		await expect(row).toContainText("已读");
		await expect(row.getByRole("button")).toHaveCount(0);
		await expect(page.getByRole("button", { name: "全部已读", exact: true })).toBeEnabled();
		expect(requests).toBe(1);
	} finally {
		finish();
	}
});

test("mobile tables can be scrolled with the keyboard", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	const region = page.getByRole("region", { name: "仓库列表", exact: true });
	await expect(region).toBeVisible();
	await region.focus();
	await page.keyboard.press("ArrowRight");
	await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("repository tabs remain reachable on a narrow screen", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/repos/octocat/hello-world");
	for (const [name, content] of [
		["安全", "Dependabot"],
		["Actions", "Build and test"],
		["PRs", "探索新的导航结构"],
		["Issues", "优化长标题在窄屏中的展示与键盘导航"],
		["发布", "v2.1.0"],
		["流量", "独立访客"],
		["语言", "TypeScript"],
		["贡献者", "reviewer"],
		["概览", "MIT"],
	] as const) {
		const tab = page.getByRole("tab", { name, exact: true });
		await tab.click();
		await expect(tab).toHaveAttribute("aria-selected", "true");
		const panel = page.getByRole("tabpanel");
		await expect(panel.getByText(content, { exact: true })).toBeVisible();
		await expect(panel.getByRole("status")).toHaveCount(0);
		if (name === "流量") {
			await expectChart(page, "views");
			await expectChart(page, "clones");
		}
		if (name === "语言") {
			await expectChart(page, "languages");
		}
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			390,
		);
	}
});

test("repository grid retains the search and links to the selected repository", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	await page.getByLabel("搜索仓库", { exact: true }).fill("hello-world");
	await page.getByText("网格", { exact: true }).click();
	const grid = page.getByTestId("repo-list");
	await expect(grid.getByRole("link")).toHaveCount(1);
	await expect(grid.getByRole("link")).toHaveAttribute("href", "/repos/octocat/hello-world");
	await expect(page.getByRole("status").filter({ hasText: "1 / 4 项" })).toBeVisible();
	await grid.getByRole("link").click();
	await expect(page).toHaveURL(/\/repos\/octocat\/hello-world$/);
	await expect(page.getByRole("tabpanel").getByText("MIT", { exact: true })).toBeVisible();
});

test("missing snapshots provide a working route to account settings", async ({ page }) => {
	await page.route("**/api/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/api/me" || path === "/api/accounts") {
			return route.fallback();
		}
		return route.fulfill({
			status: 409,
			json: { error: { code: "snapshot_missing", message: "No fixture snapshot" } },
		});
	});
	for (const path of ["/", "/issues", "/pulls", "/alerts", "/inbox", "/digest", "/insights"]) {
		await page.goto(path);
		await expect(page.getByText("没有快照", { exact: true })).toBeVisible();
		await page.getByRole("link", { name: "查看账号设置", exact: true }).click();
		await expect(page).toHaveURL(/\/settings$/);
		await expect(page.getByTestId("pat-input")).toBeVisible();
	}
});

test("unavailable security and traffic show permission guidance without zero-value charts", async ({
	page,
}) => {
	const fixtures = createUiFixtures();
	await page.route("**/api/alerts", (route) =>
		route.fulfill({ json: { ...fixtures["/api/alerts"], unavailable: true } }),
	);
	await page.route("**/api/repos/octocat/hello-world/security", (route) =>
		route.fulfill({
			json: { ...fixtures["/api/repos/octocat/hello-world/security"], unavailable: true },
		}),
	);
	await page.route("**/api/repos/octocat/hello-world/traffic", (route) =>
		route.fulfill({
			json: { ...fixtures["/api/repos/octocat/hello-world/traffic"], forbidden: true },
		}),
	);
	await page.goto("/alerts");
	await expect(page.getByText("无权限", { exact: true })).toBeVisible();
	await expect(page.getByTestId("alert-list")).toHaveCount(0);
	await page.getByRole("link", { name: "检查账号权限", exact: true }).click();
	await expect(page.getByTestId("pat-input")).toBeVisible();
	await page.goto("/repos/octocat/hello-world");
	await page.getByRole("tab", { name: "安全", exact: true }).click();
	await expect(page.getByText("无法查看安全数据", { exact: true })).toBeVisible();
	await expect(page.getByRole("tabpanel").getByText("Dependabot", { exact: true })).toHaveCount(0);
	await page.getByRole("tab", { name: "流量", exact: true }).click();
	await expect(page.getByText("无法查看流量", { exact: true })).toBeVisible();
	await expect(page.getByRole("group", { name: "views", exact: true })).toHaveCount(0);
});

test("digest without a baseline preserves unknown changes in the table and clipboard", async ({
	page,
	context,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.route("**/api/digest", (route) =>
		route.fulfill({ json: { ...createUiFixtures()["/api/digest"], baseline_missing: true } }),
	);
	await page.goto("/digest");
	await expect(page.getByText("等待第一份对比数据", { exact: true })).toBeVisible();
	await expect(
		page.getByTestId("digest-list").getByRole("row").nth(1).getByRole("cell"),
	).toHaveText(["octocat/hello-world", "—", "—", "—"]);
	await page.getByRole("button", { name: "Copy", exact: true }).click();
	const copied = await page.evaluate(() => navigator.clipboard.readText());
	expect(copied).toContain("没有昨天的基线");
	expect(copied).toContain("合计 stars — / forks — / issues —");
	expect(copied).not.toContain("+12");
});

test("repository tabs stop loading after refresh failure and can retry without stale timestamps", async ({
	page,
}) => {
	const previous = "2026-09-07T08:30:00.000Z";
	await page.route("**/api/repos/octocat/hello-world/security", (route) =>
		route.fulfill({
			json: {
				...createUiFixtures()["/api/repos/octocat/hello-world/security"],
				fetched_at: previous,
			},
		}),
	);
	await page.route("**/api/repos/octocat/hello-world/languages", (route) =>
		route.fulfill({
			status: 409,
			json: { error: { code: "snapshot_missing", message: "No fixture snapshot" } },
		}),
	);
	await page.goto("/repos/octocat/hello-world");
	const updated = page.getByTestId("repo-detail").locator("time");
	await expect(updated).toHaveAttribute("datetime", "2026-09-08T08:30:00.000Z");
	await page.getByRole("tab", { name: "安全", exact: true }).click();
	await expect(updated).toHaveAttribute("datetime", previous);
	await page.getByRole("tab", { name: "语言", exact: true }).click();
	await expect(page.getByRole("tabpanel").getByText("没有快照", { exact: true })).toBeVisible();
	await expect(updated).toHaveCount(0);
	await expect(page.getByRole("tabpanel").getByRole("status")).toHaveCount(0);
	await page.unroute("**/api/repos/octocat/hello-world/languages");
	await page.route("**/api/refresh", (route) => {
		expect(route.request().postDataJSON()).toEqual({
			account_id: "ui-account",
			kinds: ["repo:octocat/hello-world:languages"],
		});
		return route.fulfill({ json: createUiFixtures()["/api/repos/octocat/hello-world/languages"] });
	});
	await page.getByRole("button", { name: "刷新", exact: true }).click();
	await expectChart(page, "languages");
	await expect(updated).toHaveAttribute("datetime", "2026-09-08T08:30:00.000Z");
	await page.getByRole("tab", { name: "概览", exact: true }).click();
	await expect(updated).toHaveAttribute("datetime", "2026-09-08T08:30:00.000Z");
});

for (const mode of ["light", "dark", "mobile"] as const) {
	test(`${mode}: all pages render long content without clipped page actions`, async ({ page }) => {
		const width = mode === "mobile" ? 390 : 1440;
		await page.setViewportSize({ width, height: mode === "mobile" ? 844 : 1000 });
		await page.emulateMedia({ colorScheme: mode === "light" ? "light" : "dark" });
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		for (const [path, ready] of [
			["/", "repo-list"],
			["/issues", "issue-list"],
			["/pulls", "pr-list"],
			["/alerts", "alert-list"],
			["/inbox", "inbox-list"],
			["/digest", "digest-list"],
			["/settings", "pat-input"],
			["/repos/octocat/hello-world", "repo-detail"],
		] as const) {
			await page.goto(path);
			await expect(page.getByTestId(ready)).toBeVisible();
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				width,
			);
			const action = page.getByRole("button", { name: "刷新", exact: true });
			await expect(action).toBeInViewport();
			if (process.env.UI_SCREENSHOTS) {
				await page.screenshot({
					path: `${process.env.UI_SCREENSHOTS}/${mode}-${ready}.png`,
					fullPage: true,
				});
			}
		}
		await page.goto("/insights");
		for (const label of [
			"issues and pull requests by repository",
			"repositories with issues or pull requests",
			"issues and pull requests opened by week",
			"pull request review status",
			"days since last push",
			"repository health",
		]) {
			await expectChart(page, label);
		}
		const sectors = page
			.getByRole("group", { name: "pull request review status", exact: true })
			.locator(".recharts-pie-sector path");
		await expect(sectors).toHaveCount(5);
		const colors = await sectors.evaluateAll((paths) =>
			paths.map((path) => getComputedStyle(path).fill),
		);
		expect(new Set(colors).size).toBe(5);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			width,
		);
		expect(errors).toEqual([]);
		if (process.env.UI_SCREENSHOTS) {
			await page.screenshot({
				path: `${process.env.UI_SCREENSHOTS}/${mode}-insights.png`,
				fullPage: true,
			});
		}
	});
}

test("the redesigned settings form clears a rejected PAT", async ({ page }) => {
	await page.goto("/settings");
	const token = `ghp_${"B".repeat(36)}`;
	await page.getByTestId("pat-input").fill(token);
	await page.getByTestId("pat-submit").click();
	await expect(page.getByTestId("pat-input")).toHaveValue("");
	await expect(page.getByRole("alert")).toHaveText("令牌无效");
	await expect(page.getByTestId("pat-input")).toHaveAttribute("aria-invalid", "true");
	await expect(page.getByTestId("pat-submit")).toBeDisabled();
	expect(await page.content()).not.toContain(token);
	expect(
		await page.evaluate(() =>
			JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
		),
	).not.toContain(token);
});
