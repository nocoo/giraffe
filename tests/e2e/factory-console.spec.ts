import { expect, type Page, test } from "@playwright/test";
import {
	type FactoryRunResponse,
	type FactoryRunView,
	makeRun,
	runProgress,
} from "../../apps/web/src/lib/factory-run";
import { defaultSchedule } from "../../apps/web/src/lib/refresh-schedule";
import { factoryFixture } from "../fixtures/factory-snapshot";
import { createUiFixtures } from "./ui-fixtures";

function consoleFixture() {
	const snapshot = factoryFixture();
	snapshot.account_id = "ui-account";
	snapshot.status = "complete";
	snapshot.contributionStatus = "complete";
	snapshot.publication = { mixed: true, runId: "published", publishedAt: snapshot.fetched_at };
	const base = snapshot.repos[0];
	if (!base) throw new Error("fixture repository missing");
	snapshot.repos = ["app", "tools", "docs"].map((name, index) => {
		const repo = structuredClone(base);
		repo.id = `R_${index}`;
		repo.name = `nocoo/${name}`;
		repo.languageBytes = 150000 * (index + 1);
		repo.metrics.commits = 27 * (index + 1);
		repo.metrics.prMerged = 5 * (index + 1);
		repo.metrics.days["2026-09-10"] = {
			commits: 12,
			issueOpened: 2,
			issueClosed: 1,
			prOpened: 3,
			prMerged: 2,
			prClosed: 0,
			ciSuccess: 6,
			ciFailure: 1,
			releases: 1,
		};
		for (const coverage of Object.values(repo.coverage)) coverage.status = "complete";
		if (index < 2) repo.coverage.alerts.status = "unavailable";
		return repo;
	});
	snapshot.inventory.total = snapshot.inventory.scanned = snapshot.repos.length;
	const run = makeRun(
		"latest-refresh",
		snapshot.account_id,
		"nocoo",
		"fixture",
		"refresh",
		snapshot.repos,
		snapshot.fetched_at,
	);
	for (const step of run.steps) {
		step.status = step.kind === "alerts" && step.repo !== "nocoo/docs" ? "failed" : "success";
		step.error = step.status === "failed" ? "coverage_unavailable" : null;
		step.startedAt = run.startedAt;
		step.finishedAt = run.startedAt;
		step.durationMs = 2000;
		step.pages = step.repo && step.kind !== "commit" ? 1 : 0;
	}
	run.status = "partial";
	run.cursor = run.steps.length;
	run.finishedAt = run.startedAt;
	const latest: FactoryRunView = {
		...run,
		leaseUntil: null,
		progress: runProgress(run, run.startedAt),
	};
	const discovery = makeRun(
		"older-catalog",
		snapshot.account_id,
		"nocoo",
		"older",
		"catalog",
		[],
		snapshot.fetched_at,
	);
	for (const step of discovery.steps) step.status = "success";
	discovery.cursor = discovery.steps.length;
	discovery.status = "completed";
	const older: FactoryRunView = {
		...discovery,
		leaseUntil: null,
		progress: runProgress(discovery, discovery.startedAt),
	};
	const state: FactoryRunResponse = {
		account_id: snapshot.account_id,
		serverNow: snapshot.fetched_at,
		current: null,
		history: [latest, { ...older, steps: [] }],
		catalog: snapshot.repos,
		catalogComplete: true,
		catalogUpdatedAt: snapshot.fetched_at,
		nextAllowedAt: null,
		publication: "published",
		repositories: snapshot.repos.map((repo, index) => ({
			repo: repo.name,
			status: index < 2 ? "partial" : "success",
			refreshedAt: snapshot.fetched_at,
			nextAllowedAt: snapshot.fetched_at,
			coverage: index < 2 ? 6 : 7,
		})),
		storage: { resourceBytes: 31800000, totalBytes: 42000000 },
	};
	return { snapshot, state, older };
}

async function mockConsole(page: Page, fixture: ReturnType<typeof consoleFixture>) {
	const fixtures: Record<string, unknown> = {
		...createUiFixtures(),
		"/api/factory": fixture.snapshot,
		"/api/refresh/settings": {
			account_id: fixture.state.account_id,
			starred: [],
			schedules: (["daily", "weekly", "catalog"] as const).map((kind) => ({
				...defaultSchedule(kind),
				kind,
				nextAt: null,
				lastRunId: null,
				lastError: null,
			})),
		},
	};
	await page.route("**/api/**", (route) => {
		const url = new URL(route.request().url());
		if (route.request().method() !== "GET")
			return route.fulfill({
				status: 409,
				json: { error: { code: "refresh_cooldown", message: "fixture cooldown" } },
			});
		if (url.pathname === "/api/factory/runs")
			return route.fulfill({
				json: {
					...fixture.state,
					history: fixture.state.history.map((run) =>
						run.id === url.searchParams.get("history") ? fixture.older : run,
					),
				},
			});
		return url.pathname in fixtures
			? route.fulfill({ json: fixtures[url.pathname] })
			: route.fulfill({
					status: 409,
					json: { error: { code: "snapshot_missing", message: "No fixture" } },
				});
	});
}

for (const width of [1440, 390]) {
	test(`page update results keep the card gutters at ${width}px`, async ({ page }) => {
		await mockConsole(page, consoleFixture());
		await page.setViewportSize({ width, height: 740 });
		await page.goto("/refresh");
		const card = page.getByLabel("本次页面更新结果", { exact: true });
		await expect(card.getByRole("heading")).toBeVisible();
		const gutters = await card.evaluate((element) => {
			const bounds = element.getBoundingClientRect();
			const title = element.querySelector("h3")?.getBoundingClientRect();
			const description = element.querySelector("p")?.getBoundingClientRect();
			const results = element.querySelector("dl")?.getBoundingClientRect();
			if (!title || !description || !results) throw new Error("update results missing");
			return {
				title: title.left - bounds.left,
				description: description.left - bounds.left,
				left: results.left - bounds.left,
				right: bounds.right - results.right,
				bottom: bounds.bottom - results.bottom,
			};
		});
		expect(gutters.title).toBeGreaterThan(0);
		for (const gutter of Object.values(gutters)) expect(gutter).toBeCloseTo(gutters.title, 0);
	});

	for (const tab of ["刷新进度", "发起刷新", "自动刷新"]) {
		test(`refresh center scrolls with the wheel over ${tab} at ${width}px`, async ({ page }) => {
			await mockConsole(page, consoleFixture());
			await page.setViewportSize({ width, height: 640 });
			await page.emulateMedia({ reducedMotion: "reduce" });
			await page.goto("/refresh");
			await page.getByRole("tab", { name: tab, exact: true }).click();
			if (tab === "自动刷新") {
				await expect(page.getByLabel("每周深度刷新时间", { exact: true })).toBeVisible();
			}
			const storage = page.getByText("数据时间与存储用量", { exact: true });
			await expect(storage).not.toBeInViewport();
			const body = await page.locator(".factory-console-body").boundingBox();
			if (!body) throw new Error("refresh content missing");
			await page.mouse.move(body.x + 8, 540);
			await page.mouse.wheel(0, 10000);
			await expect(storage).toBeInViewport();
			await storage.click();
			await expect(page.getByText("全站数据占用 42.0 MB。", { exact: false })).toBeAttached();
			await expect(page.locator(".factory-console")).not.toContainText("256");
			await page.mouse.move(body.x + 8, 540);
			await page.mouse.wheel(0, 10000);
			await expect(page.getByRole("button", { name: "重新读取页面数据" })).toBeInViewport();
			await page.mouse.wheel(0, -10000);
			await expect(
				page.locator(".factory").getByRole("heading", { name: "刷新中心", exact: true }),
			).toBeInViewport();
		});
	}
}

test("time inputs follow the chosen application theme independently of the system", async ({
	page,
}) => {
	await mockConsole(page, consoleFixture());
	await page.emulateMedia({ colorScheme: "dark" });
	await page.goto("/refresh");
	await page.getByRole("tab", { name: "自动刷新", exact: true }).click();
	const time = page.getByLabel("每日快速刷新时间", { exact: true });
	const toggle = page.getByRole("button", { name: /切换主题/ });
	await expect(time).toHaveCSS("color-scheme", "dark");
	await toggle.click();
	await expect(time).toHaveCSS("color-scheme", "light");
	await toggle.click();
	await expect(time).toHaveCSS("color-scheme", "dark");
	await page.emulateMedia({ colorScheme: "light" });
	await expect(time).toHaveCSS("color-scheme", "dark");
	await toggle.click();
	await expect(time).toHaveCSS("color-scheme", "light");
});

test("refresh center replaces the factory dialog and keeps optional diagnostics centralized", async ({
	page,
}) => {
	const fixture = consoleFixture();
	await mockConsole(page, fixture);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto("/factory");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByText("未能读取安全告警", { exact: true })).toHaveCount(0);
	await page.getByRole("link", { name: "去刷新", exact: true }).click();
	await expect(page).toHaveURL(/\/refresh/);
	const center = page.getByRole("region", { name: "刷新管理" });
	await expect(center).toBeVisible();
	await expect(center.getByText("未能读取安全告警", { exact: true })).toBeVisible();
	await expect(center.locator(".factory-run-overview h3")).toContainText("深度刷新 · 手动");
	const results = center.getByRole("radiogroup", { name: "筛选刷新结果", exact: true });
	await results.getByRole("radio", { name: "需关注 2", exact: true }).click();
	await expect(center.locator(".factory-run-row")).toHaveCount(2);
	await results.getByRole("radio", { name: "全部 3", exact: true }).click();
	await expect(center.locator(".factory-run-row")).toHaveCount(3);
	await center
		.locator(".factory-run-row")
		.filter({ hasText: "nocoo/app" })
		.locator("summary")
		.first()
		.click();
	await expect(
		center
			.locator(".factory-run-row")
			.filter({ hasText: "nocoo/app" })
			.locator(".factory-step-timeline>li"),
	).toHaveCount(18);
	await page.screenshot({
		path: ".factory-cache/refresh-console/center-desktop.png",
		fullPage: true,
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
	expect(await page.locator("body").evaluate((e) => e.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({
		path: ".factory-cache/refresh-console/center-mobile.png",
		fullPage: true,
	});
});

test("the console distinguishes page failures from successful factory publication", async ({
	page,
}) => {
	const fixture = consoleFixture();
	const run = fixture.state.history[0];
	const repos = run?.steps.find((step) => step.resource === "repos");
	if (!repos) throw new Error("fixture page missing");
	repos.status = "failed";
	repos.error = "snapshot_incomplete";
	await mockConsole(page, fixture);
	await page.goto("/refresh");
	const results = page.getByLabel("本次页面更新结果", { exact: true });
	await expect(results).toBeVisible();
	const row = (name: string) =>
		results
			.locator("dl > div")
			.filter({ has: page.locator("dt", { hasText: new RegExp(`^${name}$`) }) });
	await expect(row("仓库")).toContainText("未更新，保留原数据");
	await expect(row("Insights")).toContainText("已更新");
	await expect(row("CI 与发布")).toContainText("已更新");
	await expect(row("软件工厂")).toContainText("已更新");
});

test("leaving and returning restores progress; pause, resume and cancel preserve publication", async ({
	page,
}) => {
	const fixture = consoleFixture();
	const active = makeRun(
		"active-refresh",
		fixture.snapshot.account_id,
		"nocoo",
		"active",
		"refresh",
		fixture.snapshot.repos,
		fixture.snapshot.fetched_at,
	);
	const update = () => {
		fixture.state.current = {
			...active,
			leaseUntil: null,
			progress: runProgress(active, fixture.snapshot.fetched_at),
		};
	};
	update();
	await mockConsole(page, fixture);
	const controls: string[] = [];
	await page.route("**/api/factory/runs/active-refresh/control", (route) => {
		const action = route.request().postDataJSON().action as string;
		controls.push(action);
		active.status = action === "pause" ? "paused" : action === "resume" ? "running" : "cancelled";
		if (action === "cancel")
			for (const step of active.steps)
				if (step.status === "pending" || step.status === "running") {
					step.status = "skipped";
					step.error = "cancelled";
				}
		update();
		if (action === "cancel") {
			fixture.state.history.unshift({
				...active,
				leaseUntil: null,
				progress: runProgress(active, fixture.snapshot.fetched_at),
			});
			fixture.state.current = null;
		}
		return route.fulfill({ json: { account_id: active.account_id, id: active.id } });
	});
	await page.goto("/factory");
	await page.getByRole("link", { name: "去刷新", exact: true }).click();
	await page.getByRole("link", { name: "返回软件工厂", exact: true }).click();
	for (const step of active.steps.slice(0, 4)) step.status = "success";
	active.cursor = 4;
	update();
	await page.getByRole("link", { name: "去刷新", exact: true }).click();
	await expect(page.getByRole("progressbar", { name: "列表页刷新进度" })).toHaveAttribute(
		"value",
		"4",
		{ timeout: 10000 },
	);
	await page.getByRole("button", { name: "查看进度", exact: true }).click();
	await page.getByRole("button", { name: "暂停刷新", exact: true }).click();
	await expect(page.getByRole("button", { name: "继续刷新", exact: true })).toBeEnabled();
	await page.getByRole("button", { name: "继续刷新", exact: true }).click();
	await expect(page.getByRole("button", { name: "暂停刷新", exact: true })).toBeEnabled();
	await page.getByRole("button", { name: "结束本次刷新", exact: true }).click();
	await expect(page.getByRole("heading", { name: /已取消 · 深度刷新/ })).toBeVisible();
	await expect(
		page.locator(".factory-run-row").first().getByText("未执行完", { exact: true }),
	).toBeVisible();
	expect(controls).toEqual(["pause", "resume", "cancel"]);
	await page.getByRole("link", { name: "返回软件工厂", exact: true }).click();
	await expect(page.locator(".factory-period")).toBeVisible();

	await expect(page.getByRole("progressbar", { name: "列表页刷新进度" })).toHaveCount(0);
});

test("history stays in the console and a failed start remains explained after polling", async ({
	page,
}) => {
	const fixture = consoleFixture();
	await mockConsole(page, fixture);
	await page.goto("/factory");
	await page.getByRole("link", { name: "去刷新", exact: true }).click();
	await page.getByRole("combobox", { name: "运行记录", exact: true }).click();
	await page.getByRole("option", { name: /已完成 · 同步列表/ }).click();
	await expect(page.getByRole("progressbar", { name: "本次刷新进度" })).toHaveAttribute("max", "4");
	await page.getByRole("link", { name: "返回软件工厂", exact: true }).click();
	await expect(page.getByRole("progressbar", { name: "列表页刷新进度" })).toHaveCount(0);
	await page.getByRole("link", { name: "去刷新", exact: true }).click();
	await page.getByRole("button", { name: "选择这 2 个仓库重试", exact: true }).click();
	await expect(page.getByRole("tab", { name: "发起刷新" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(page.getByRole("checkbox", { name: "nocoo/app", exact: true })).toBeChecked();
	await expect(page.getByRole("checkbox", { name: "nocoo/tools", exact: true })).toBeChecked();
	await expect(page.getByRole("checkbox", { name: "nocoo/docs", exact: true })).not.toBeChecked();
	await page.getByRole("button", { name: "设置优先级", exact: true }).click();
	await page.getByRole("spinbutton", { name: "nocoo/tools 优先级", exact: true }).fill("1");
	const request = page.waitForRequest(
		(request) => request.url().endsWith("/api/factory/runs") && request.method() === "POST",
	);
	await page.getByRole("button", { name: "开始刷新（2）", exact: true }).click();
	expect((await request).postDataJSON()).toMatchObject({
		repos: ["nocoo/tools", "nocoo/app"],
		order: ["nocoo/tools", "nocoo/app"],
		depth: "quick",
	});
	await expect(page.getByRole("alert")).toContainText("倒计时");
	await page.getByRole("button", { name: "重试读取", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("倒计时");
});

test("selecting one repository limits the console to its nine detail pages", async ({ page }) => {
	const fixture = consoleFixture();
	fixture.state.current = null;
	fixture.state.history = [];
	fixture.state.catalogComplete = false;
	await mockConsole(page, fixture);
	await page.route("**/api/factory/runs", async (route) => {
		if (route.request().method() !== "POST") return route.fallback();
		const input = route.request().postDataJSON();
		expect(input).toMatchObject({ scope: "selected", repos: ["nocoo/app"] });
		const run = makeRun(
			"single-repo",
			fixture.snapshot.account_id,
			"nocoo",
			"single",
			"refresh",
			fixture.snapshot.repos.filter((repo) => repo.name === "nocoo/app"),
			fixture.snapshot.fetched_at,
			[],
			fixture.snapshot.repos.map((repo) => repo.name),
			input,
		);
		fixture.state.current = { ...run, leaseUntil: null, progress: runProgress(run, run.startedAt) };
		return route.fulfill({ status: 202, json: { id: run.id, totalSteps: run.steps.length } });
	});
	await page.goto("/refresh");
	const dialog = page.getByRole("region", { name: "刷新管理" });
	await dialog.getByRole("combobox", { name: "刷新范围", exact: true }).click();
	await page.getByRole("option", { name: "手动选择仓库", exact: true }).click();
	await dialog.getByRole("checkbox", { name: "nocoo/app", exact: true }).check();
	await expect(dialog.getByText(/仅更新所选仓库/)).toBeVisible();
	await dialog.getByRole("button", { name: "开始刷新（1）", exact: true }).click();
	await expect(dialog.getByRole("progressbar", { name: "本次刷新进度" })).toHaveAttribute(
		"max",
		"19",
	);
	const stages = dialog.locator(".factory-run-phases>li");
	await expect(stages).toHaveCount(3);
	await expect(stages.filter({ hasText: "仓库页面" })).toContainText("0 / 9");
	await expect(stages.filter({ hasText: "AI 分析" })).toHaveCount(0);
	await expect(dialog.getByText("全站页面", { exact: true })).toHaveCount(0);
	await expect(dialog.locator(".factory-run-row")).toHaveCount(1);
	await expect(dialog.locator(".factory-run-row")).toContainText("nocoo/app");
});

test("refresh center configures daily and weekly jobs, keeps drafts while polling and labels depth", async ({
	page,
}) => {
	const fixture = consoleFixture();
	await mockConsole(page, fixture);
	const settings = {
		account_id: fixture.state.account_id,
		starred: ["nocoo/app"],
		schedules: [
			{
				kind: "daily",
				enabled: true,
				time: "08:00",
				weekday: 0,
				scope: "starred",
				nextAt: "2026-09-28T00:00:00.000Z",
				lastRunId: null,
				lastError: null,
			},
			{
				kind: "weekly",
				enabled: true,
				time: "04:00",
				weekday: 0,
				scope: "all",
				nextAt: "2026-10-03T20:00:00.000Z",
				lastRunId: null,
				lastError: null,
			},
			{
				...defaultSchedule("catalog"),
				kind: "catalog",
				nextAt: null,
				lastRunId: null,
				lastError: null,
			},
		],
	};
	await page.route("**/api/refresh/**", (route) => {
		if (new URL(route.request().url()).pathname === "/api/refresh/times")
			return route.fulfill({ json: { account_id: fixture.state.account_id, runs: [] } });
		if (route.request().method() === "POST") {
			const input = route.request().postDataJSON();
			expect(input.account_id).toBe(fixture.state.account_id);
			const schedule = settings.schedules.find((s) => route.request().url().endsWith(s.kind));
			if (schedule) Object.assign(schedule, input);
		}
		return route.fulfill({ json: settings });
	});
	await page.goto("/refresh");
	await page.getByRole("tab", { name: "自动刷新", exact: true }).click();
	await expect(page.getByText(/已星标 1 个仓库/)).toBeVisible();
	await page.getByLabel("每日快速刷新时间", { exact: true }).fill("09:15");
	await page.getByRole("button", { name: "保存计划", exact: true }).first().click();
	await expect(page.getByRole("status").filter({ hasText: "已保存" })).toBeVisible();
	expect(settings.schedules[0]?.time).toBe("09:15");
	await page.getByRole("switch", { name: "启用每周深度刷新", exact: true }).click();
	await page.getByRole("button", { name: "保存计划", exact: true }).nth(1).click();
	await expect.poll(() => settings.schedules[1]?.enabled).toBe(false);
	await page.getByRole("switch", { name: "启用每日同步仓库列表", exact: true }).click();
	await page.getByLabel("每日同步仓库列表时间", { exact: true }).fill("06:30");
	await page.getByRole("button", { name: "保存计划", exact: true }).nth(2).click();
	await expect.poll(() => settings.schedules[2]?.enabled).toBe(true);
	expect(settings.schedules[2]?.time).toBe("06:30");
	await page.reload();
	await page.getByRole("tab", { name: "自动刷新", exact: true }).click();
	await expect(page.getByLabel("每日快速刷新时间", { exact: true })).toHaveValue("09:15");
	await expect(page.getByLabel("每日同步仓库列表时间", { exact: true })).toHaveValue("06:30");
	await expect(
		page.getByRole("switch", { name: "启用每周深度刷新", exact: true }),
	).not.toBeChecked();
	await page.setViewportSize({ width: 390, height: 844 });
	expect(await page.locator("body").evaluate((e) => e.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({
		path: ".factory-cache/refresh-console/schedules-mobile.png",
		fullPage: true,
	});
	await page.getByRole("tab", { name: "发起刷新", exact: true }).click();
	await page.getByRole("combobox", { name: "刷新模式", exact: true }).click();
	await page.getByRole("option", { name: "完整深度刷新", exact: true }).click();
	const request = page.waitForRequest(
		(r) => r.method() === "POST" && r.url().endsWith("/api/factory/runs"),
	);
	await page.getByRole("button", { name: "开始刷新（3）", exact: true }).click();
	expect((await request).postDataJSON().depth).toBe("deep");
});

for (const [timeZone, expected] of [
	["Asia/Shanghai", "2026年9月17日 04:01:12"],
	["America/Los_Angeles", "2026年9月16日 13:01:12"],
]) {
	test(`refresh timestamps follow the browser zone ${timeZone}`, async ({ browser }) => {
		const context = await browser.newContext({ timezoneId: timeZone });
		try {
			const page = await context.newPage();
			const fixture = consoleFixture();
			const run = fixture.state.history[0];
			if (!run) throw new Error("fixture run missing");
			run.startedAt = "2026-09-16T20:01:12Z";
			await mockConsole(page, fixture);
			await page.goto("/refresh");
			await page.getByText("运行信息", { exact: true }).click();
			await expect(page.getByText(`开始 ${expected}`, { exact: false })).toBeVisible();
			await expect(
				page.getByText(`时间按本地时区（${timeZone}）显示。`, { exact: false }),
			).toBeVisible();
			await expect(page.locator(".factory-console")).not.toContainText(" UTC");
		} finally {
			await context.close();
		}
	});
}

test("catalogue sync shares the refresh selector and records automatic provenance", async ({
	page,
}) => {
	const fixture = consoleFixture();
	fixture.state.catalog = [];
	fixture.state.catalogComplete = false;
	fixture.state.history = [];
	await mockConsole(page, fixture);
	let request: Record<string, unknown> | undefined;
	await page.route("**/api/factory/runs", async (route) => {
		if (route.request().method() !== "POST") return route.fallback();
		request = route.request().postDataJSON();
		return route.fulfill({ status: 202, json: { id: "catalogue-run", totalSteps: 4 } });
	});
	await page.goto("/refresh");
	await page.getByRole("tab", { name: "发起刷新", exact: true }).click();
	await page.getByRole("combobox", { name: "刷新模式", exact: true }).click();
	await page.getByRole("option", { name: "同步仓库列表", exact: true }).click();
	await expect(page.getByRole("combobox", { name: "刷新范围", exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "同步仓库列表", exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "开始刷新", exact: true }).click();
	await expect.poll(() => request?.mode).toBe("catalog");
	expect(request).toMatchObject({ scope: "all", depth: "quick" });
	expect(request).not.toHaveProperty("repos");
	expect(request).not.toHaveProperty("order");
	fixture.older.trigger = "daily";
	fixture.state.history = [fixture.older];
	await page.getByRole("button", { name: "更新状态", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "已完成 · 同步列表 · 每日自动", exact: true }),
	).toBeVisible();
	await page.getByRole("combobox", { name: "运行记录", exact: true }).click();
	await expect(page.getByRole("option", { name: /同步列表 · 每日自动/ })).toBeVisible();
});
