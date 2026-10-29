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

test("retired Work routes expose no controls or runtime requests", async ({ page }) => {
	const runtimeRequests: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.pathname.startsWith("/api/agent/") || url.pathname.startsWith("/api/cli/"))
			runtimeRequests.push(url.pathname);
	});
	await page.goto("/work");
	await expect(page.getByText("页面不存在", { exact: true })).toBeVisible();
	await expect(page.locator('a[href="/work"]')).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Agent", exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /暂停|恢复执行/ })).toHaveCount(0);
	expect(runtimeRequests).toEqual([]);
	await page.goto("/repos");
	await expect(page.getByTestId("repo-list")).toBeVisible();
	await expect(page.getByRole("button", { name: "分析台", exact: true })).toHaveCount(0);
});

test("repository and Insights omit optional security warnings while showing saved data", async ({
	page,
}) => {
	const snapshot = createUiFixtures()["/api/repos"];
	await page.route(
		(url) => url.pathname === "/api/insights",
		(route) =>
			route.fulfill({ json: { ...createUiFixtures()["/api/insights"], alerts_incomplete: true } }),
	);
	await page.clock.setFixedTime(new Date(Date.parse(snapshot.fetched_at) + 5 * 86400000));
	await page.goto("/repos");
	const updated = page.getByRole("button", { name: "数据更新时间：5 天前更新" });
	await expect(updated).toBeVisible();
	await updated.click();
	await expect(page.getByRole("dialog", { name: "数据更新时间" }).locator("time")).toHaveAttribute(
		"datetime",
		snapshot.fetched_at,
	);
	await page.keyboard.press("Escape");
	await expect(page.getByText("可选安全告警未完整获取")).toHaveCount(0);
	await expect(page.getByText("告警不完整", { exact: true })).toHaveCount(0);
	await page.goto("/insights");
	await expect(page.getByTestId("insight-metrics")).toBeVisible();
	await expect(page.getByText("可选安全告警未完整获取")).toHaveCount(0);
});

for (const width of [1440, 390]) {
	test(`repository tabs keep their position during first loading at ${width}px`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 900 });
		const fixtures = createUiFixtures();
		const updated = "2026-09-10T12:00:00.000Z";
		let finish = () => {};
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		await page.route("**/api/repos/octocat/hello-world/issues", async (route) => {
			await pending;
			await route.fulfill({
				json: { ...fixtures["/api/repos/octocat/hello-world/issues"], fetched_at: updated },
			});
		});
		await page.goto("/repos/octocat/hello-world");
		const repo = page.getByTestId("repo-detail");
		const header = repo.locator(":scope > header");
		const tabs = page.getByRole("tablist", { name: "仓库详情" });
		await expect(page.getByRole("button", { name: /^数据更新时间：/ })).toBeVisible();
		await expect(header.locator("time")).toHaveCount(0);
		const initialTop = await tabs.evaluate((el) => el.getBoundingClientRect().top);
		const initialHeight = await header.evaluate((el) => el.getBoundingClientRect().height);
		const expectPosition = async () => {
			expect(await tabs.evaluate((el) => el.getBoundingClientRect().top)).toBe(initialTop);
			expect(await header.evaluate((el) => el.getBoundingClientRect().height)).toBe(initialHeight);
		};
		await page.clock.install();
		await page.clock.pauseAt(new Date(Date.now() + 100));
		try {
			await page.getByRole("tab", { name: "Issues", exact: true }).dispatchEvent("mousedown", {
				button: 0,
			});
			const panel = page.getByRole("tabpanel", { name: "Issues", exact: true });
			await expect(panel).toBeAttached();
			expect
				.soft(await panel.evaluate((el) => el.getBoundingClientRect().height))
				.toBeGreaterThan(0);
			await expectPosition();
			await expect(header.locator("time")).toBeHidden();
			const loadingHeight = await panel.evaluate((el) => el.getBoundingClientRect().height);
			await page.clock.runFor(250);
			await expect(page.getByRole("status", { name: "加载 Issues" })).toBeVisible();
			// The tab-in transform leaves sub-pixel float noise; a real layout jump is whole pixels.
			expect(await panel.evaluate((el) => el.getBoundingClientRect().height)).toBeCloseTo(
				loadingHeight,
				0,
			);
			await expectPosition();
			finish();
			await expect(panel.getByRole("table")).toBeVisible();
			await page.getByRole("button", { name: /^数据更新时间：/ }).click();
			await expect(
				page.getByRole("dialog", { name: "数据更新时间" }).locator("time"),
			).toHaveAttribute("datetime", updated);
			await page.keyboard.press("Escape");
			await expectPosition();
			await page.clock.resume();
			await page.getByRole("tab", { name: "概览", exact: true }).click();
			await page.getByRole("tab", { name: "Issues", exact: true }).click();
			await expect(panel.getByRole("table")).toBeVisible();
			await expectPosition();
		} finally {
			finish();
		}
	});
}

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
	["/repos", "搜索仓库", "repo-list"],
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

test("insights keeps deterministic CI and alert reasons without analysis links", async ({
	page,
}) => {
	await page.goto("/insights");
	await expect(page.getByRole("list", { name: "Top 10 关注仓库" })).toBeVisible();
	await expect(page.getByTestId("insight-focus")).toContainText("Release 连续 2 次失败");
	await expect(page.getByRole("link", { name: /查看分析报告与证据/ })).toHaveCount(0);
	await expect(page.getByText("AI 总评：优先处理")).toHaveCount(0);
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
	let reads = 0;
	page.on("request", (request) => {
		if (new URL(request.url()).pathname === "/api/notifications" && request.method() === "GET")
			reads++;
	});
	await page.route(
		(url) => url.pathname === "/api/notifications/read",
		async (route) => {
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
		},
	);
	try {
		await page.goto("/inbox");
		const row = page.getByTestId("inbox-list").getByRole("row").filter({ hasText: "优化长标题" });
		const mark = row.getByRole("button", { name: "标为已读", exact: true });
		await expect(mark).toBeVisible();
		await mark.click();
		await expect(mark).toBeDisabled();
		await expect(page.getByRole("button", { name: "当前范围已读", exact: true })).toBeDisabled();
		finish();
		await expect(row).toContainText("已读");
		await expect(row.getByRole("button")).toHaveCount(0);
		await expect(page.getByRole("button", { name: "当前范围已读", exact: true })).toBeEnabled();
		expect(requests).toBe(1);
		expect(reads).toBe(1);
	} finally {
		finish();
	}
});

test("mobile tables can be scrolled with the keyboard", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/repos");
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
	await page.goto("/repos");
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

test("missing snapshots keep honest empty states and an explicit account refresh control", async ({
	page,
}) => {
	await page.route("**/api/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/api/me" || path === "/api/accounts" || path.startsWith("/api/refresh-runs")) {
			return route.fallback();
		}
		return route.fulfill({
			status: 409,
			json: { error: { code: "snapshot_missing", message: "No fixture snapshot" } },
		});
	});
	await page.goto("/alerts");
	await expect(page.getByText("暂无告警数据", { exact: true })).toBeVisible();
	for (const path of ["/repos", "/issues", "/pulls", "/inbox", "/insights"]) {
		await page.goto(path);
		await expect(page.getByText("暂无已保存的快照", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "刷新数据", exact: true }).click();
		await expect(page.getByRole("button", { name: "开始刷新", exact: true })).toBeEnabled();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("link", { name: "前往刷新中心", exact: true })).toHaveCount(0);
		await expect(page.getByText(/旧刷新已停用/)).toHaveCount(0);
	}
});

test("legacy security stays unknown while traffic retains permission guidance", async ({
	page,
}) => {
	const fixtures = createUiFixtures();
	await page.route(
		(url) => url.pathname === "/api/alerts",
		(route) =>
			route.fulfill({ json: { ...fixtures["/api/alerts"], items: [], unavailable: true } }),
	);
	await page.route("**/api/repos/octocat/hello-world/security", (route) =>
		route.fulfill({
			json: {
				...fixtures["/api/repos/octocat/hello-world/security"],
				unavailable: true,
				dependabot_open: 0,
				code_scanning_open: 0,
			},
		}),
	);
	await page.route("**/api/repos/octocat/hello-world/traffic", (route) =>
		route.fulfill({
			json: { ...fixtures["/api/repos/octocat/hello-world/traffic"], forbidden: true },
		}),
	);
	await page.goto("/alerts");
	await expect(page.getByText("暂无告警数据", { exact: true })).toBeVisible();
	await expect(page.getByTestId("alert-list")).toHaveCount(0);
	await expect(page.getByText("检查账号权限", { exact: true })).toHaveCount(0);
	await page.goto("/repos/octocat/hello-world");
	await page.getByRole("tab", { name: "安全", exact: true }).click();
	await expect(
		page.getByRole("img", { name: "Dependabot — 旧快照：功能状态未知", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("img", { name: "Code scanning — 旧快照：功能状态未知", exact: true }),
	).toBeVisible();
	await page.getByRole("tab", { name: "流量", exact: true }).click();
	await expect(page.getByText("无法查看流量", { exact: true })).toBeVisible();
	await expect(page.getByRole("group", { name: "views", exact: true })).toHaveCount(0);
});

test("missing repository tabs remain read-only and show newly saved snapshots", async ({
	page,
}) => {
	const writes: string[] = [];
	page.on("request", (request) => {
		if (new URL(request.url()).pathname.startsWith("/api/") && request.method() !== "GET")
			writes.push(request.url());
	});
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
	const expectTime = async (at: string) => {
		await page.getByRole("button", { name: /^数据更新时间：/ }).click();
		const source = page
			.getByRole("dialog", { name: "数据更新时间" })
			.locator("dl > div")
			.filter({ has: page.getByText("当前标签页", { exact: true }) });
		await expect(source.locator("time")).toHaveAttribute("datetime", at);
		await page.keyboard.press("Escape");
	};
	await expectTime("2026-09-08T08:30:00.000Z");
	await page.getByRole("tab", { name: "安全", exact: true }).click();
	await expectTime(previous);
	await page.getByRole("tab", { name: "语言", exact: true }).click();
	await expect(
		page.getByRole("tabpanel").getByText("暂无已保存的快照", { exact: true }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "数据更新时间：暂无数据时间" })).toBeVisible();
	expect(await page.getByTestId("repo-detail").ariaSnapshot()).not.toContain("上次刷新");
	await expect(page.getByRole("tabpanel").getByRole("status")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "刷新此仓库", exact: true })).toBeVisible();
	await page.unroute("**/api/repos/octocat/hello-world/languages");
	await page.reload();
	await page.getByRole("tab", { name: "语言", exact: true }).click();
	await expectChart(page, "languages");
	await expectTime("2026-09-08T08:30:00.000Z");
	await page.getByRole("tab", { name: "概览", exact: true }).click();
	await expectTime("2026-09-08T08:30:00.000Z");
	expect(writes).toEqual([]);
});

for (const mode of ["light", "dark", "mobile"] as const) {
	test(`${mode}: pages fit long content with shared account and repository refresh controls`, async ({
		page,
	}) => {
		const width = mode === "mobile" ? 390 : 1440;
		await page.setViewportSize({ width, height: mode === "mobile" ? 844 : 1000 });
		await page.emulateMedia({ colorScheme: mode === "light" ? "light" : "dark" });
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		for (const [path, ready] of [
			["/repos", "repo-list"],
			["/issues", "issue-list"],
			["/pulls", "pr-list"],
			["/alerts", "alert-list"],
			["/inbox", "inbox-list"],
			["/ci", "ci-list"],
			["/settings", "pat-input"],
			["/repos/octocat/hello-world", "repo-detail"],
		] as const) {
			await page.goto(path);
			await expect(page.getByTestId(ready)).toBeVisible();
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				width,
			);
			await expect(
				page.getByRole("main").getByRole("button", { name: "刷新此仓库", exact: true }),
			).toHaveCount(path.startsWith("/repos/octocat/") ? 1 : 0);
			await expect(page.getByRole("button", { name: "刷新数据", exact: true })).toBeVisible();
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
	await expect(page.locator("#pat-error")).toHaveText("令牌无效");
	await expect(page.getByTestId("pat-input")).toHaveAttribute("aria-invalid", "true");
	await expect(page.getByTestId("pat-submit")).toBeDisabled();
	expect(await page.content()).not.toContain(token);
	expect(
		await page.evaluate(() =>
			JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
		),
	).not.toContain(token);
});

test("CI page separates consecutive failures from recurring ones and filters the stream list", async ({
	page,
}) => {
	await page.goto("/ci");
	const summary = page.getByTestId("ci-summary");
	await expect(summary.getByText("需要处理", { exact: true })).toBeVisible();
	const act = page.locator(".giraffe-ci-card");
	await expect(act).toHaveCount(1);
	await expect(act).toContainText("hello-world");
	await expect(act).toContainText("连续 2 次");
	await expect(page.getByRole("heading", { name: /^反复失败 · 1/ })).toBeVisible();
	const strip = act.locator(".giraffe-run-cells i:not([data-empty])");
	await expect(strip).toHaveCount(3);
	await expect(strip.last()).toHaveAttribute("data-latest", "true");
	await expect(strip.last()).toHaveAttribute("title", /失败 · 最新$/);
	await expect(page.getByText("1 个仓库未采集", { exact: true })).toBeVisible();
	const list = page.getByTestId("ci-list");
	await expect(list.getByRole("row")).toHaveCount(10);
	await page.getByRole("radio", { name: "持续失败", exact: true }).click();
	await expect(list.getByRole("row")).toHaveCount(6);
	await page
		.getByLabel("工作流筛选", { exact: true })
		.getByRole("radio", { name: "全部", exact: true })
		.click();
	await page.getByLabel("搜索工作流", { exact: true }).fill("field");
	await expect(list.getByRole("row")).toHaveCount(7);
	const releases = page.getByTestId("release-list");
	await expect(releases.getByRole("row").nth(1)).toContainText("v2.1.0");
	await expect(releases.getByRole("row").nth(1)).toContainText("持续失败");
});

test("CI health uses saved default-branch verdicts and labels observational units separately", async ({
	page,
}) => {
	const fixture = createUiFixtures()["/api/ci"];
	expect(fixture.repos.find((repo) => repo.repo === "octocat/no-default")).toMatchObject({
		verdict: "unknown",
		release: { pipeline: "none" },
	});
	expect(fixture.totals.unknownRepos).toBe(1);
	await page.clock.setFixedTime(new Date("2027-01-01T00:00:00Z"));
	await page.goto("/ci");
	const summary = page.getByTestId("ci-summary");
	const tile = (label: string) => summary.locator("dl > div").filter({ hasText: label });
	await expect(tile("需要处理").locator("strong")).toHaveText("1");
	await expect(tile("需要处理").locator("small")).toContainText("1 个仓库");
	await expect(tile("继续观察").locator("strong")).toHaveText("1");
	await expect(tile("无近期运行").locator("strong")).toHaveText("1");
	await expect(summary).toContainText("14 天");
	await summary.getByRole("button", { name: "CI 判定汇总说明" }).focus();
	await expect(page.getByRole("tooltip")).toContainText("非默认分支 4 条观察线、8 次失败运行");
	await expect(page.getByRole("tooltip")).toContainText("不影响仓库和工作流健康");
	await page.keyboard.press("Escape");
	const list = page.getByTestId("ci-list");
	await expect(
		list.getByRole("row").filter({ hasText: "field-notes" }).filter({ hasText: "分支观察" }),
	).toHaveCount(4);
	const recovered = list.getByRole("row").filter({ hasText: "basalt" });
	await expect(recovered).toContainText("偶发失败");
	await expect(recovered).not.toContainText("持续失败");
	const idle = list.getByRole("row").filter({ hasText: "L3 Stress Reproduction" });
	await expect(idle).toContainText("无近期运行");
	await expect(idle).toContainText("14 天没有运行");
	for (const branch of ["deleted/pr", "v1.2.3", "未知引用"]) {
		const observation = list.getByRole("row").filter({ hasText: branch });
		await expect(observation).toContainText("分支观察");
	}
	await expect(page.locator(".giraffe-ci-card")).toHaveCount(1);
	await expect(page.locator(".giraffe-ci-card")).not.toContainText("field-notes");
	await expect(
		page.getByTestId("release-list").getByRole("row").filter({ hasText: "no-default" }),
	).toBeVisible();
	expect(fixture.totals).toMatchObject({
		brokenWorkflows: 1,
		brokenRepos: 1,
		idleWorkflows: 1,
		nonDefaultBranchStreams: 4,
		nonDefaultBranchFailures: 8,
	});
});

for (const width of [1440, 390]) {
	for (const theme of ["light", "dark"] as const) {
		test(`CI run strips align empty slots and use outcome outlines at ${width}px in ${theme}`, async ({
			page,
		}, info) => {
			await page.setViewportSize({ width, height: 1000 });
			await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
			const report = createUiFixtures()["/api/ci"];
			const template = report.streams[0];
			if (!template) throw new Error("Missing CI fixture stream");
			const histories = [
				["success", 1],
				["failure", 3],
				["other", 5],
				["pending", 10],
			] as const;
			report.streams = histories.map(([outcome, count]) => ({
				...template,
				workflow: outcome,
				recent: Array.from({ length: count }, (_, id) => ({
					outcome,
					id,
					at: report.now,
					event: "push",
					branch: "main",
				})),
			}));
			report.streams.push({ ...template, workflow: "empty", recent: [] });
			await page.route("**/api/ci?*", (route) => route.fulfill({ json: report }));
			await page.goto("/ci");
			const list = page.getByTestId("ci-list");
			const rows = list.locator("tbody tr");
			await expect(rows).toHaveCount(5);
			const edges: { left: number; right: number }[] = [];
			for (const [index, [outcome, count]] of histories.entries()) {
				const strip = rows.nth(index).locator(".giraffe-run-cells");
				await expect(strip.locator("i")).toHaveCount(10);
				await expect(strip.locator("[data-empty]")).toHaveCount(10 - count);
				await expect(strip.locator("i:not([data-empty])")).toHaveCount(count);
				expect(
					await strip
						.locator("i")
						.evaluateAll((cells) => cells.map((cell) => cell.hasAttribute("data-empty"))),
				).toEqual([...Array(10 - count).fill(true), ...Array(count).fill(false)]);
				const latest = strip.locator("i").last();
				await expect(latest).toHaveAttribute("data-latest", "true");
				const appearance = await latest.evaluate((element) => {
					const style = getComputedStyle(element);
					const box = element.getBoundingClientRect();
					return {
						background: style.backgroundColor,
						outline: style.boxShadow,
						left: box.left,
						right: box.right,
					};
				});
				expect(appearance.outline, outcome).toContain(`${appearance.background} 0px 0px 0px 3px`);
				edges.push(appearance);
			}
			expect(new Set(edges.map((box) => box.left)).size).toBe(1);
			expect(new Set(edges.map((box) => box.right)).size).toBe(1);
			const empty = rows.last().locator(".giraffe-run-cells");
			await expect(empty).toHaveAttribute("aria-label", "没有运行记录");
			await expect(empty.locator("[data-empty][aria-hidden=true]")).toHaveCount(10);
			await expect(empty.locator("[data-latest]")).toHaveCount(0);
			const placeholder = empty.locator("i").first();
			const emptyColor = await placeholder.evaluate(
				(element) => getComputedStyle(element).backgroundColor,
			);
			expect(emptyColor).not.toBe("rgba(0, 0, 0, 0)");
			expect(emptyColor).not.toBe(
				await rows
					.nth(2)
					.locator("[data-latest]")
					.evaluate((element) => getComputedStyle(element).backgroundColor),
			);
			const opacity = await placeholder.evaluate((element) => {
				const canvas = document.createElement("canvas");
				const context = canvas.getContext("2d");
				if (!context) throw new Error("Canvas is unavailable");
				context.fillStyle = getComputedStyle(element).backgroundColor;
				context.fillRect(0, 0, 1, 1);
				return context.getImageData(0, 0, 1, 1).data[3];
			});
			expect(opacity).toBeGreaterThan(0);
			expect(opacity).toBeLessThanOrEqual(40);
			await list.scrollIntoViewIfNeeded();
			await page.screenshot({ path: info.outputPath("ci-run-strips.png"), animations: "disabled" });
			expect(
				await page.locator("body").evaluate((element) => element.scrollWidth),
			).toBeLessThanOrEqual(width);
		});
	}
}
