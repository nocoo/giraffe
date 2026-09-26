import { expect, type Page, test } from "@playwright/test";
import {
	type FactoryRunResponse,
	type FactoryRunView,
	makeRun,
	runProgress,
} from "../../src/lib/factory-run";
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
		storage: { resourceBytes: 31800000, limitBytes: 256000000 },
	};
	return { snapshot, state, older };
}

async function mockConsole(page: Page, fixture: ReturnType<typeof consoleFixture>) {
	const fixtures: Record<string, unknown> = {
		...createUiFixtures(),
		"/api/factory": fixture.snapshot,
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

test("factory opens a large accessible console while keeping one compact health banner on the page", async ({
	page,
}) => {
	const fixture = consoleFixture();
	const now = new Date(Date.parse(fixture.snapshot.fetched_at) + 3 * 86400000 + 7200000);
	await page.clock.setFixedTime(now);
	fixture.state.serverNow = now.toISOString();
	for (const run of fixture.state.history) run.finishedAt = now.toISOString();
	await mockConsole(page, fixture);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto("/factory");
	const trigger = page.getByRole("button", { name: "刷新控制台", exact: true });
	await expect(page.getByRole("dialog")).toHaveCount(0);
	const banner = page.getByRole("region", { name: "数据健康与刷新进度" });
	await expect(banner).toHaveAttribute("data-tone", "info");
	await expect(banner).not.toContainText("安全告警");
	await expect(banner).not.toContainText("安全状态未知");
	await expect(banner).toContainText("快照更新");
	await expect(banner.locator("time")).toHaveAttribute("datetime", fixture.snapshot.fetched_at);
	await expect(banner.locator("time")).toContainText("3 天前");
	await expect(page.getByRole("progressbar", { name: "列表页刷新进度" })).toHaveCount(0);
	expect((await banner.boundingBox())?.height).toBeLessThanOrEqual(56);
	expect((await page.locator(".factory-period").boundingBox())?.y).toBeLessThan(450);
	expect((await trigger.boundingBox())?.x).toBeGreaterThan(900);
	await page.screenshot({
		path: ".factory-cache/refresh-console/list-desktop.png",
		fullPage: false,
	});
	await trigger.click();
	const dialog = page.getByRole("dialog", { name: "刷新控制台" });
	await expect(dialog).toBeVisible();
	await expect(dialog).toHaveCSS("opacity", "1");
	expect(await dialog.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
		"rgba(0, 0, 0, 0)",
	);
	const bounds = await dialog.boundingBox();
	expect(bounds?.width).toBeGreaterThan(1000);
	expect(bounds?.height).toBeGreaterThan(700);
	await expect(dialog.locator(".factory-run-phases>li")).toHaveCount(6);
	await expect(dialog.locator(".factory-issue")).toHaveCount(1);
	await expect(dialog.getByText("未能读取安全告警", { exact: true })).toBeVisible();
	await expect(
		dialog.getByText("无法判断这些仓库是否有依赖漏洞，不能当成零告警。", { exact: true }),
	).toBeVisible();
	await expect(
		dialog.locator(".factory-issue-guidance").getByText(/security_events/),
	).toBeVisible();
	const resultFilter = dialog.getByRole("radiogroup", { name: "筛选刷新结果", exact: true });
	await expect(resultFilter).toHaveClass(/basalt-ui/);
	await expect(resultFilter.getByRole("radio", { name: "需关注 2", exact: true })).toHaveCSS(
		"font-size",
		"13px",
	);
	await resultFilter.getByRole("radio", { name: "需关注 2", exact: true }).click();
	await expect(dialog.locator(".factory-run-row")).toHaveCount(2);
	await resultFilter.getByRole("radio", { name: "全部 3", exact: true }).click();
	await expect(dialog.locator(".factory-run-row")).toHaveCount(3);
	const colors = await dialog
		.locator(".factory-progress-segments>span")
		.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor));
	expect(new Set(colors).size).toBe(3);
	await page.screenshot({
		path: ".factory-cache/refresh-console/dialog-desktop.png",
		fullPage: false,
		animations: "disabled",
	});
	const row = dialog.locator(".factory-run-row").filter({ hasText: "nocoo/app" });
	await row.locator("summary").first().click();
	await expect(row.locator(".factory-step-timeline>li")).toHaveCount(19);
	await expect(row.getByText(/未能读取安全告警/)).toBeVisible();
	await dialog.getByRole("button", { name: "关闭刷新控制台" }).focus();
	await page.keyboard.press("Shift+Tab");
	await expect(dialog.getByRole("button", { name: "返回软件工厂" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toBeFocused();
	await expect(page.getByRole("progressbar", { name: "列表页刷新进度" })).toHaveCount(0);
	await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
	await trigger.click();
	await page.screenshot({
		path: ".factory-cache/refresh-console/dialog-dark.png",
		fullPage: false,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "关闭刷新控制台" }).click();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({
		path: ".factory-cache/refresh-console/list-mobile.png",
		fullPage: false,
	});
	await trigger.click();
	await expect(dialog).toBeVisible();
	await expect(dialog).toHaveCSS("opacity", "1");
	expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	expect(await page.locator("body").evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
		390,
	);
	await page.screenshot({
		path: ".factory-cache/refresh-console/dialog-mobile.png",
		fullPage: false,
		animations: "disabled",
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
	await page.goto("/factory?refresh=1");
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

test("closing the console keeps polling and pause, resume and cancel preserve published data", async ({
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
	await page.getByRole("button", { name: "刷新控制台", exact: true }).click();
	await page.getByRole("button", { name: "关闭刷新控制台" }).click();
	for (const step of active.steps.slice(0, 4)) step.status = "success";
	active.cursor = 4;
	update();
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
	await expect(page.getByRole("heading", { name: "已取消", exact: true })).toBeVisible();
	await expect(
		page.locator(".factory-run-row").first().getByText("未执行完", { exact: true }),
	).toBeVisible();
	expect(controls).toEqual(["pause", "resume", "cancel"]);
	await page.getByRole("button", { name: "关闭刷新控制台" }).click();
	await expect(page.locator(".factory-period")).toBeVisible();
	await expect(page.getByText("数据可用，更新时间不一致", { exact: true })).toBeVisible();
	await expect(page.getByRole("progressbar", { name: "列表页刷新进度" })).toHaveCount(0);
});

test("history stays in the console and a failed start remains explained after polling", async ({
	page,
}) => {
	const fixture = consoleFixture();
	await mockConsole(page, fixture);
	await page.goto("/factory");
	await page.getByRole("button", { name: "刷新控制台", exact: true }).click();
	await page.getByRole("combobox", { name: "运行记录", exact: true }).click();
	await page.getByRole("option", { name: /已完成 · 同步列表/ }).click();
	await expect(page.getByRole("progressbar", { name: "本次刷新进度" })).toHaveAttribute("max", "4");
	await page.getByRole("button", { name: "关闭刷新控制台" }).click();
	await expect(page.getByRole("progressbar", { name: "列表页刷新进度" })).toHaveCount(0);
	await page.getByRole("button", { name: "查看详情", exact: true }).click();
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
	await page.goto("/factory?refresh=1");
	const dialog = page.getByRole("dialog", { name: "刷新控制台" });
	await dialog.getByRole("combobox", { name: "刷新范围", exact: true }).click();
	await page.getByRole("option", { name: "手动选择仓库", exact: true }).click();
	await dialog.getByRole("checkbox", { name: "nocoo/app", exact: true }).check();
	await expect(dialog.getByText(/仅更新所选仓库/)).toBeVisible();
	await dialog.getByRole("button", { name: "开始刷新（1）", exact: true }).click();
	await expect(dialog.getByRole("progressbar", { name: "本次刷新进度" })).toHaveAttribute(
		"max",
		"20",
	);
	const stages = dialog.locator(".factory-run-phases>li");
	await expect(stages).toHaveCount(4);
	await expect(stages.filter({ hasText: "仓库页面" })).toContainText("0 / 9");
	await expect(stages.filter({ hasText: "AI 分析" })).toContainText("0 / 1");
	await expect(dialog.getByText("全站页面", { exact: true })).toHaveCount(0);
	await expect(dialog.locator(".factory-run-row")).toHaveCount(1);
	await expect(dialog.locator(".factory-run-row")).toContainText("nocoo/app");
});

test("refresh progress waits for JEV judgment and the AI report before showing completion", async ({
	page,
}, testInfo) => {
	const fixture = consoleFixture();
	const run = makeRun(
		"ai-progress",
		fixture.snapshot.account_id,
		"nocoo",
		"ai-key",
		"refresh",
		fixture.snapshot.repos.slice(0, 1),
		fixture.snapshot.fetched_at,
		[],
		[],
		{ scope: "selected" },
	);
	const ai = run.steps.find((step) => step.kind === "assessment");
	if (!ai) throw new Error("AI step missing");
	for (const step of run.steps)
		if (step.kind !== "assessment" && step.kind !== "publish") step.status = "success";
	ai.status = "running";
	ai.assessmentStage = "judgment";
	ai.startedAt = run.startedAt;
	run.cursor = run.steps.indexOf(ai);
	run.nextAttemptAt = new Date(Date.now() + 5000).toISOString();
	const view = { ...run, leaseUntil: null, progress: runProgress(run, run.startedAt) };
	fixture.state.current = view;
	await mockConsole(page, fixture);
	await page.goto("/factory?refresh=1");
	const dialog = page.getByRole("dialog", { name: "刷新控制台" });
	const current = dialog.locator(".factory-current-step");
	const progress = dialog.getByRole("progressbar", { name: "本次刷新进度" });
	await expect(current).toContainText("正在处理：nocoo/app · AI 分析 · JEV 判断");
	await expect(progress).toHaveAttribute("value", "18");
	await expect(progress).toHaveAttribute("max", "20");
	await expect(
		dialog.locator(".factory-run-phases>li").filter({ hasText: "AI 分析" }),
	).toContainText("0 / 1");
	await page.screenshot({ path: testInfo.outputPath("ai-analysis-progress.png") });
	await dialog.locator(".factory-run-row>summary").click();
	await expect(
		dialog.locator(".factory-step-timeline>li").filter({ hasText: "AI 分析" }),
	).toContainText("正在分析");
	ai.assessmentStage = "summary";
	await expect(current).toContainText("AI 分析 · 生成报告", { timeout: 10000 });
	await expect(progress).toHaveAttribute("value", "18");
	for (const step of view.steps) step.status = "success";
	view.status = "completed";
	view.cursor = view.steps.length;
	view.progress = runProgress(view, run.startedAt);
	fixture.state.current = null;
	fixture.state.history.unshift(view);
	await expect(progress).toHaveAttribute("value", "20", { timeout: 10000 });
	await expect(dialog.locator(".factory-run-overview h3")).toHaveText("已完成");
});
