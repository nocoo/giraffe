import { expect, type Page, test } from "@playwright/test";
import { APP_VERSION } from "../../src/lib/version";
import { factoryFixture } from "../fixtures/factory-snapshot";
import { createUiFixtures } from "./ui-fixtures";

test.use({ timezoneId: "Asia/Shanghai" });

async function mockPages(page: Page) {
	const snapshot = factoryFixture();
	snapshot.account_id = "ui-account";
	snapshot.status = "complete";
	const base = snapshot.repos[0];
	if (!base) throw new Error("fixture repository missing");
	snapshot.repos = ["app", "tools", "empty"].map((name, index) => {
		const repo = structuredClone(base);
		repo.id = `R_${index}`;
		repo.name = `nocoo/${name}`;
		repo.language = index === 1 ? "Swift" : "TypeScript";
		repo.languageBytes = index === 2 ? 0 : 150000 * (index + 1);
		if (index < 2) {
			repo.observation = {
				version: `V_${index}`,
				metadataAt: "2026-09-17T22:55:37.000Z",
				refreshedAt: "2026-09-17T22:55:43.000Z",
				window: {
					since: "2026-06-20T00:00:00.000Z",
					until: "2026-09-17T22:55:37.000Z",
				},
				source: index === 0 ? "run" : "legacy",
			};
		}
		for (const item of Object.values(repo.coverage)) item.status = "complete";
		repo.metrics.commits = 12;
		repo.metrics.prMerged = 2;
		repo.metrics.days["2026-09-10"] = {
			commits: 12,
			issueOpened: 2,
			issueClosed: 1,
			prOpened: 3,
			prMerged: 2,
			prClosed: 1,
			ciSuccess: 6,
			ciFailure: 1,
			releases: 1,
		};
		if (index === 1) {
			repo.coverage.commits.status = "limited";
			repo.coverage.commits.observed = 18;
			repo.metrics.commits = 18;
			repo.metrics.days["2026-09-11"] = { ...repo.metrics.days["2026-09-10"], commits: 6 };
		}
		return repo;
	});
	snapshot.inventory.total = snapshot.inventory.scanned = snapshot.repos.length;
	const fixtures: Record<string, unknown> = {
		...createUiFixtures(),
		"/api/factory": snapshot,
		"/api/factory/runs": {
			account_id: snapshot.account_id,
			serverNow: snapshot.fetched_at,
			current: null,
			history: [],
			catalog: snapshot.repos,
			catalogComplete: true,
			catalogUpdatedAt: snapshot.fetched_at,
			nextAllowedAt: null,
			publication: null,
			repositories: [],
		},
	};
	await page.route("**/api/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		return route.request().method() === "GET" && path in fixtures
			? route.fulfill({ json: fixtures[path] })
			: route.fulfill({
					status: 409,
					json: { error: { code: "snapshot_missing", message: "Fixture only" } },
				});
	});
}

test.beforeEach(async ({ page }) => {
	await mockPages(page);
	await page.emulateMedia({ reducedMotion: "reduce" });
});

test("Basalt card typography is consistent across factory, insights and repository charts", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	for (const [path, heading] of [
		["/factory", "提交日历"],
		["/insights", "仓库覆盖"],
	] as const) {
		await page.goto(path);
		await expect(page.getByRole("heading", { name: heading, exact: true })).toHaveCSS(
			"font-size",
			"16px",
		);
	}
	await expect(page.getByText(`v${APP_VERSION}`, { exact: true })).toHaveCSS(
		"font-family",
		/monospace/,
	);
	await page.goto("/repos/octocat/hello-world");
	await page.getByRole("tab", { name: "流量", exact: true }).click();
	await expect(page.getByRole("heading", { name: "浏览趋势", exact: true })).toHaveCSS(
		"font-size",
		"16px",
	);
	await expect(page.getByText("最近 14 天的仓库页面访问", { exact: true })).not.toBeVisible();
	await page.getByRole("button", { name: "浏览趋势说明", exact: true }).hover();
	await expect(page.getByRole("tooltip")).toHaveCSS("font-size", "13px");
	const ticks = page.locator(".recharts-cartesian-axis-tick-value");
	await expect(ticks.first()).toBeVisible();
	expect(
		await ticks.evaluateAll((items) =>
			items.every((item) => Number.parseFloat(getComputedStyle(item).fontSize) >= 12),
		),
	).toBe(true);
});

test("multicolor chart series stay distinct in both themes across factory, insights and repo detail", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	for (const mode of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme: mode });
		for (const [path, label, marks, property] of [
			["/factory", "交付吞吐", ".recharts-bar-rectangle path", "fill"],
			["/factory", "仓库规模地图", ".recharts-treemap-depth-1 rect", "fill"],
			["/factory", "仓库提交与开放工作", ".recharts-scatter-symbol path", "fill"],
			[
				"/insights",
				"repositories with issues or pull requests",
				".recharts-pie-sector path",
				"fill",
			],
			["/repos/octocat/hello-world", "languages", ".recharts-pie-sector path", "fill"],
		] as const) {
			await page.goto(path);
			await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
			await expect(page.locator("html")).toHaveAttribute("data-accent", "green");
			if (label === "languages") await page.getByRole("tab", { name: "语言", exact: true }).click();
			const colors = page.getByRole("group", { name: label, exact: true }).locator(marks);
			await expect(colors.first()).toBeVisible();
			// ResponsiveContainer replaces its first SVG on measurement. Re-query
			// until paint is settled rather than sampling detached first-render paths.
			await expect
				.poll(
					async () => {
						const channels = await colors.evaluateAll((elements, property) => {
							const canvas = document.createElement("canvas");
							const context = canvas.getContext("2d");
							if (!context) throw new Error("Canvas unavailable");
							return elements.map((element) => {
								if (!element.isConnected) return [];
								context.clearRect(0, 0, 1, 1);
								context.fillStyle = getComputedStyle(element).getPropertyValue(property);
								context.fillRect(0, 0, 1, 1);
								return [...context.getImageData(0, 0, 1, 1).data];
							});
						}, property);
						return (
							channels.length > 0 &&
							channels.every(
								([red = 0, green = 0, blue = 0, alpha = 0]) =>
									alpha > 0 && Math.max(red, green, blue) - Math.min(red, green, blue) > 20,
							) &&
							(label !== "交付吞吐" || new Set(channels.map(String)).size === 2)
						);
					},
					{ message: `${mode}: ${label} uses distinct palette colors` },
				)
				.toBe(true);
			if (label === "仓库提交与开放工作") {
				await colors.first().scrollIntoViewIfNeeded();
				await page.screenshot({
					path: `.factory-cache/green/factory-${mode}.png`,
					animations: "disabled",
				});
			}
		}
	}
});

test("card help is compact, supports hover and keyboard, and charts keep green keyboard focus", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto("/factory");
	const help = page.getByRole("button", { name: "交付吞吐说明", exact: true });
	await expect(help).toBeVisible();
	await expect(page.getByText(/事件类别相加，不代表唯一工作项/)).not.toBeVisible();
	await help.hover();
	await expect(page.getByRole("tooltip")).toContainText("事件类别相加，不代表唯一工作项");
	await page.keyboard.press("Escape");
	await page.mouse.move(0, 0);
	await page.keyboard.press("Tab");
	await help.focus();
	await expect(page.getByRole("tooltip")).toBeVisible();
	await page.keyboard.press("Escape");
	await page.keyboard.press("Tab");
	const surface = page
		.getByRole("group", { name: "交付吞吐", exact: true })
		.locator("svg.recharts-surface");
	await expect(surface).toBeFocused();
	await expect(surface).toHaveCSS("outline-style", "solid");
	await expect(surface).toHaveCSS("outline-width", "2px");
	const keyboardColor = await surface.evaluate((element) => getComputedStyle(element).outlineColor);
	const primaryColor = await page
		.getByRole("button", { name: "刷新控制台", exact: true })
		.evaluate((element) => getComputedStyle(element).backgroundColor);
	expect(keyboardColor).toBe(primaryColor);
	await page.getByRole("heading", { name: "交付吞吐", exact: true }).click();
	await surface.click({ position: { x: 10, y: 10 } });
	await expect(surface).toBeFocused();
	await expect(surface).toHaveCSS("outline-style", "none");
	const chart = page.getByRole("group", { name: "交付吞吐", exact: true });
	for (const target of [
		chart.locator(".recharts-cartesian-axis-tick-value").first(),
		chart.getByTestId("chart-legend").getByText("合并 PR", { exact: true }),
	]) {
		await target.click();
		const focused = await page.evaluate(() => {
			const element = document.activeElement;
			return element
				? {
						className: element.getAttribute("class"),
						outline: getComputedStyle(element).outlineStyle,
					}
				: null;
		});
		expect(focused?.outline, JSON.stringify(focused)).toBe("none");
	}
});

test.describe("touch help", () => {
	test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
	test("card help opens on tap and dismisses outside", async ({ page }) => {
		await page.goto("/factory");
		await page.getByRole("button", { name: "交付吞吐说明", exact: true }).tap();
		await expect(page.getByRole("tooltip")).toContainText("事件类别相加，不代表唯一工作项");
		await page.getByRole("heading", { name: "交付吞吐", exact: true }).tap();
		await expect(page.getByRole("tooltip")).not.toBeVisible();
	});
});

test("chart content fills cards, donut charts use the plot area and table gutters align", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto("/factory");
	for (const title of [
		"提交日历",
		"交付吞吐",
		"仓库规模地图",
		"提交与待办",
		"工作流量账",
		"依赖与维护",
	]) {
		const heading = page.getByRole("heading", { name: title, exact: true });
		await expect(heading).toBeVisible();
		const gap = await heading.evaluate((element) => {
			const card = element.closest("[data-basalt-surface]");
			const last = card?.lastElementChild?.lastElementChild;
			if (!card || !last) throw new Error("Card content missing");
			return card.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
		});
		expect(gap, `${title} bottom whitespace`).toBeLessThanOrEqual(20);
	}
	for (const grid of await page.locator(".factory-chart-grid").all()) {
		const bottoms = await grid
			.locator(":scope > [data-basalt-surface]")
			.evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().bottom));
		expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThanOrEqual(1);
	}
	const lowerCards = await Promise.all(
		["需要检查的信号", "依赖与维护"].map((title) =>
			page
				.getByRole("heading", { name: title, exact: true })
				.evaluate(
					(element) =>
						element.closest("[data-basalt-surface]")?.getBoundingClientRect().bottom ?? 0,
				),
		),
	);
	expect(Math.max(...lowerCards) - Math.min(...lowerCards)).toBeLessThanOrEqual(1);
	const scatter = page
		.getByRole("group", { name: "仓库提交与开放工作", exact: true })
		.locator("svg.recharts-surface");
	await expect.poll(async () => (await scatter.boundingBox())?.height ?? 0).toBeGreaterThan(300);
	const repoRow = page
		.getByRole("row")
		.filter({ has: page.getByRole("button", { name: "查看 nocoo/app 的数据时间", exact: true }) });
	const cell = repoRow.getByRole("cell").first();
	await expect(cell).toHaveCSS("padding-left", "16px");
	await expect(cell).toHaveCSS("padding-top", "12px");
	expect(
		await cell.evaluate(
			(element) =>
				element.getBoundingClientRect().left -
				(element.closest("[data-basalt-surface]")?.getBoundingClientRect().left ?? 0),
		),
	).toBeLessThanOrEqual(1);
	await page.getByRole("button", { name: /2026-09-10 UTC.*点击查看当日统计/ }).click();
	await expect(page.locator(".factory-ledger-selected")).toHaveAttribute("aria-selected", "true");
	await page.goto("/insights");
	const chart = page.getByRole("group", {
		name: "repositories with issues or pull requests",
		exact: true,
	});
	const surface = chart.locator("svg.recharts-surface");
	const ring = chart.locator(".recharts-pie");
	await expect(ring).toBeVisible();
	await expect
		.poll(async () => {
			const plot = await surface.boundingBox();
			const bounds = await ring.boundingBox();
			return (bounds?.height ?? 0) / Math.min(plot?.height ?? 1, plot?.width ?? 1);
		})
		.toBeGreaterThan(0.7);
	await page.goto("/issues");
	await expect(page.getByTestId("issue-list").locator("td").first()).toHaveCSS(
		"padding-left",
		"16px",
	);
});

test("signal list expands fully and fills the space beside a taller dependency card", async ({
	page,
}) => {
	const snapshot = factoryFixture();
	snapshot.account_id = "ui-account";
	snapshot.status = "complete";
	const base = snapshot.repos[0];
	if (!base) throw new Error("fixture repository missing");
	const names = ["app", "tools", "api", "web"];
	snapshot.repos = names.map((name, index) => {
		const repo = structuredClone(base);
		repo.id = `R_${index}`;
		repo.name = `nocoo/${name}`;
		repo.metrics.agedIssues = repo.metrics.agedPrs = 1;
		repo.dependencies = names
			.filter((target) => target !== name)
			.map((target) => ({
				name: `nocoo/${target}`,
				version: "abc",
				path: ".github/workflows/ci.yml",
				url: `https://github.com/nocoo/${name}/blob/abc/.github/workflows/ci.yml`,
			}));
		return repo;
	});
	snapshot.inventory.total = snapshot.inventory.scanned = snapshot.repos.length;
	await page.route("**/api/factory", (route) => route.fulfill({ json: snapshot }));
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto("/factory");
	const list = page.locator(".factory-signal-list");
	await expect(list.getByRole("button")).toHaveCount(8);
	const originalHeight = await list.evaluate((element) => element.clientHeight);
	expect(originalHeight).toBeGreaterThan(220);
	expect(await list.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
	await page.getByText("全部引用与范围", { exact: true }).click();
	expect(await list.evaluate((element) => element.clientHeight)).toBeGreaterThan(originalHeight);
	const bottomGap = await list.evaluate((element) => {
		const body = element.parentElement;
		if (!body) throw new Error("signal card content missing");
		return body.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom;
	});
	expect(bottomGap).toBeLessThanOrEqual(20);
	await page.setViewportSize({ width: 390, height: 844 });
	expect(await list.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
});

test("calendar edge cells keep selection and keyboard focus inside the grid", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto("/factory");
	const days = page.locator(".factory-day");
	for (const day of [days.first(), days.last()]) {
		await day.click();
		await expect(day).toHaveAttribute("aria-pressed", "true");
		for (const keyboard of [false, true]) {
			if (keyboard) {
				await page.keyboard.press("Tab");
				await day.focus();
			}
			const outline = await day.evaluate((element) => {
				const style = getComputedStyle(element);
				return Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
			});
			expect(outline).toBeLessThanOrEqual(0);
		}
	}
});

for (const [chart, values] of [
	["PR 流量与存量", ["新开9", "合并6", "未合并关闭 ↓3", "日终 open3"]],
	["Issue 流量与存量", ["新开6", "关闭3", "日终 open2"]],
	["提交产出与覆盖面", ["提交≥ 36", "7 日活跃仓库3"]],
	["交付吞吐", ["合并 PR6", "Release3", "CI 7 日成功率85.7%"]],
] as const) {
	test(`${chart} tooltip displays daily values and leaves the page usable`, async ({ page }) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.goto("/factory");
		const plot = page.getByRole("group", { name: chart, exact: true });
		const bar = plot
			.locator(".recharts-bar")
			.first()
			.locator(".recharts-bar-rectangle path")
			.filter({ visible: true })
			.first();
		await bar.scrollIntoViewIfNeeded();
		const bounds = await bar.boundingBox();
		if (!bounds) throw new Error("Daily chart bar missing");
		await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
		const tip = plot.locator(".factory-chart-tip");
		await expect(tip).toBeVisible();
		await expect(tip.locator("strong")).toHaveText("2026-09-10 UTC");
		await expect(tip.getByTestId("chart-tooltip-row")).toHaveText([...values]);
		await page.mouse.move(0, 0);
		await expect(tip).not.toBeVisible();
		await page.getByRole("button", { name: /2026-09-10 UTC.*点击查看当日统计/ }).click();
		await expect(page.locator(".factory-ledger-selected")).toContainText("2026-09-10");
		expect(errors).toEqual([]);
	});
}

test("factory visualizations use Basalt chart frames and preserve keyboard drilldowns", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto("/factory");
	for (const label of [
		"交付吞吐",
		"仓库规模地图",
		"仓库提交与开放工作",
		"窗口内每日默认分支提交",
	]) {
		const plot = page
			.getByRole("group", { name: label, exact: true })
			.locator(".basalt-chart svg.recharts-surface");
		await expect(plot).toBeVisible();
		expect((await plot.boundingBox())?.width).toBeGreaterThan(50);
		await plot.screenshot({ path: `.factory-cache/basalt/${label}.png`, animations: "disabled" });
	}
	await page.screenshot({
		path: ".factory-cache/basalt/factory-light.png",
		animations: "disabled",
	});
	await expect(page.locator(".factory-repo-link")).toHaveCount(3);
	const partialSpark = page.getByRole("group", { name: "nocoo/tools 每日提交", exact: true });
	const partialLine = partialSpark.locator(".recharts-line-curve");
	await expect(partialLine).toBeVisible();
	// Only two adjacent days were observed; missing days must not extend a zero baseline.
	expect((await partialLine.boundingBox())?.width).toBeLessThan(10);
	const tile = page.getByRole("button", {
		name: "nocoo/app，150,000 语言字节，打开仓库",
		exact: true,
	});
	await tile.focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/repo=nocoo%2Fapp/);
	await page.getByRole("button", { name: "返回仓库群", exact: true }).click();
	const day = page.getByRole("button", { name: /2026-09-10 UTC.*点击查看当日统计/ });
	await day.click();
	await expect(day).toHaveAttribute("aria-pressed", "true");
	await expect(page.locator("#factory-ledger")).toHaveAttribute("open", "");
	await expect(page.locator(".factory-ledger-selected")).toContainText("2026-09-10");
});

test("factory Basalt controls and larger text fit mobile and dark mode", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.addInitScript(() => localStorage.setItem("theme", "dark"));
	await page.goto("/factory");
	await page.getByRole("combobox", { name: "语言群", exact: true }).click();
	await page.getByRole("option", { name: "Swift", exact: true }).click();
	await expect(page.locator(".factory-repo-link")).toHaveCount(1);
	await expect(page.locator(".factory-repo-link")).toHaveText("nocoo/tools");
	await expect(page.locator(".factory select")).toHaveCount(0);
	const scatter = page.getByRole("group", { name: "仓库提交与开放工作", exact: true });
	await expect(scatter.locator("svg.recharts-surface")).toBeVisible();
	await expect
		.poll(async () => (await scatter.locator("svg.recharts-surface").boundingBox())?.height ?? 0)
		.toBeGreaterThanOrEqual(250);
	await scatter.scrollIntoViewIfNeeded();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({
		path: ".factory-cache/green/factory-mobile-dark.png",
		animations: "disabled",
	});
	await page.getByRole("button", { name: "查看 nocoo/tools 的数据时间", exact: true }).click();
	expect(
		await page
			.getByRole("dialog", { name: "数据时间", exact: true })
			.evaluate((element) => element.scrollWidth <= element.clientWidth),
	).toBe(true);
	await page.screenshot({
		path: ".factory-cache/basalt/data-time-mobile-dark.png",
		animations: "disabled",
	});
	await page.getByRole("button", { name: "关闭数据时间", exact: true }).click();
	await page.getByRole("button", { name: "刷新控制台", exact: true }).click();
	await page.getByRole("tab", { name: "发起刷新", exact: true }).click();
	await expect(page.getByRole("heading", { name: "选择要更新的仓库", exact: true })).toHaveCSS(
		"font-size",
		"16px",
	);
	await page.getByRole("combobox", { name: "刷新范围", exact: true }).click();
	await page.getByRole("option", { name: "手动选择仓库", exact: true }).click();
	await page.getByRole("checkbox", { name: "nocoo/app", exact: true }).check();
	await expect(page.getByRole("button", { name: "开始刷新（1）", exact: true })).toBeEnabled();
	await expect(page.locator(".factory-console select")).toHaveCount(0);
	await expect(page.getByRole("checkbox", { name: "nocoo/app", exact: true })).toHaveClass(
		/basalt-ui/,
	);
	expect(
		await page
			.getByRole("dialog")
			.evaluate((element) => element.scrollWidth <= element.clientWidth),
	).toBe(true);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({ path: ".factory-cache/basalt/dialog-mobile-dark.png" });
});

test("repository timestamps stay in a Basalt dialog and elapsed time ticks every second", async ({
	page,
}) => {
	await page.clock.install({ time: new Date("2026-09-17T23:59:00.000Z") });
	await page.goto("/factory");
	const trigger = page.getByRole("button", { name: "查看 nocoo/app 的数据时间", exact: true });
	await expect(trigger).toBeVisible();
	await expect(trigger).toHaveCSS("white-space", "nowrap");
	await page.clock.pauseAt(new Date("2026-09-18T00:00:00.000Z"));
	const row = page.getByRole("row").filter({ has: trigger });
	await expect(row.getByRole("cell").last()).toContainText("数据时间");
	await expect(row).not.toContainText("2026-");
	await expect(row).not.toContainText("元数据");
	await trigger.click();
	const dialog = page.getByRole("dialog", { name: "数据时间", exact: true });
	await expect(dialog).toContainText("Asia/Shanghai");
	await expect(dialog).toContainText("2026年9月18日 06:55:37");
	await expect(dialog).toContainText("2026年6月20日 08:00:00");
	const metadata = dialog.getByRole("timer", { name: "仓库信息更新距今" });
	const events = dialog.getByRole("timer", { name: "活动数据更新距今" });
	await expect(metadata).toHaveText("1 小时 4 分 23 秒前");
	await expect(events).toHaveText("1 小时 4 分 17 秒前");
	await page.clock.runFor(1000);
	await expect(metadata).toHaveText("1 小时 4 分 24 秒前");
	await expect(events).toHaveText("1 小时 4 分 18 秒前");
	await page.screenshot({ path: ".factory-cache/basalt/data-time.png", animations: "disabled" });
	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();
	await page.clock.runFor(1);
	await expect(trigger).toBeFocused();
	await page.clock.runFor(60000);
	await trigger.click();
	await expect(metadata).toHaveText("1 小时 5 分 24 秒前");
	await page.keyboard.press("Escape");
	await page.clock.runFor(1);
	await page.getByRole("button", { name: "查看 nocoo/tools 的数据时间", exact: true }).click();
	await expect(dialog).toContainText("旧版采集记录");
	await page.keyboard.press("Escape");
	await page.clock.runFor(1);
	await page.getByRole("button", { name: "查看 nocoo/empty 的数据时间", exact: true }).click();
	await expect(dialog).toContainText("尚未采集活动数据");
	await expect(dialog.getByRole("timer")).toHaveCount(0);
});

test("other pages are read-only and missing data leads to the unified factory console", async ({
	page,
}) => {
	const writes: string[] = [];
	page.on("request", (request) => {
		if (new URL(request.url()).pathname.startsWith("/api/") && request.method() !== "GET")
			writes.push(request.url());
	});
	for (const [path, content] of [
		["/", "repo-list"],
		["/issues", "issue-list"],
		["/pulls", "pr-list"],
		["/alerts", "alert-list"],
		["/inbox", "inbox-list"],
		["/insights", "insight-metrics"],
		["/settings", "pat-input"],
		["/repos/octocat/hello-world", "repo-detail"],
	] as const) {
		await page.goto(path);
		await expect(page.getByTestId(content)).toBeVisible();
		await expect(page.getByRole("button", { name: /刷新/ })).toHaveCount(0);
		await expect(page.getByText("首个账号添加成功后会自动同步仓库。", { exact: true })).toHaveCount(
			0,
		);
	}
	await page.route("**/api/repos/octocat/hello-world/traffic", (route) =>
		route.fulfill({
			status: 409,
			json: { error: { code: "snapshot_missing", message: "no snapshot" } },
		}),
	);
	await page.getByRole("tab", { name: "流量", exact: true }).click();
	await expect(page.getByText("等待统一刷新", { exact: true })).toBeVisible();
	await page.getByRole("link", { name: "前往刷新控制台", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "刷新控制台", exact: true })).toBeVisible();
	expect(writes).toEqual([]);
});
