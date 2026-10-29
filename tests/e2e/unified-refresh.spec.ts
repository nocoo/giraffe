import { expect, type Locator, type Page, test } from "@playwright/test";
import type { FactoryViewSnapshot } from "../../apps/web/src/lib/factory-types";
import type { RefreshRun } from "../../apps/web/src/lib/refresh-types";
import { createUiFixtures } from "./ui-fixtures";

const repository = "octocat/hello-world";
const otherDimensions = ["Issues", "PRs", "CI / Actions", "发布", "依赖告警"];

async function openRefresh(page: Page, repo = false) {
	await expect(page.getByRole("dialog", { name: "统一刷新", exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: repo ? "刷新此仓库" : "刷新数据", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "统一刷新", exact: true });
	await expect(dialog.getByRole("button", { name: "开始刷新", exact: true })).toBeEnabled();
	return dialog;
}

async function commitsOnly(dialog: Locator) {
	if ((await dialog.locator("details").getAttribute("open")) === null) {
		await dialog.locator("summary").click();
	}
	for (const name of otherDimensions) {
		await dialog.getByRole("checkbox", { name, exact: true }).uncheck();
	}
}

async function startRefresh(
	page: Page,
	dialog: Locator,
	repos: string[],
	verifySharedLock = false,
) {
	const started = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/api/refresh-runs" &&
			response.request().method() === "POST",
	);
	await dialog.getByRole("button", { name: "开始刷新", exact: true }).click();
	const response = await started;
	expect(response.status()).toBe(202);
	const run = (await response.json()) as RefreshRun;
	expect(run.status).toBe("queued");
	expect(run.phase).toBe("account");
	const terminal = page.waitForResponse(
		async (result) =>
			new URL(result.url()).pathname === `/api/refresh-runs/${run.id}` &&
			result.request().method() === "GET" &&
			result.ok() &&
			["completed", "partial", "failed"].includes(((await result.json()) as RefreshRun).status),
		{ timeout: 30_000 },
	);
	await expect(dialog.getByRole("button", { name: "刷新进行中", exact: true })).toBeDisabled();
	await expect(dialog.getByRole("status")).toContainText(/排队中|刷新中/);
	await expect(dialog.getByRole("status")).toContainText("A · 账号信息、贡献趋势与仓库清单");
	if (verifySharedLock) {
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		await page.getByRole("button", { name: "刷新数据", exact: true }).click();
		await expect(dialog.getByRole("button", { name: "刷新进行中", exact: true })).toBeDisabled();
	}
	const finished = (await (await terminal).json()) as RefreshRun;
	expect(finished.status).toBe("completed");
	expect(finished.phase).toBe("done");
	expect(finished.repos).toEqual(repos);
	expect(finished.completedRepos).toBe(repos.length);
	expect(finished.errorCode).toBeNull();
	await expect(dialog.getByRole("status")).toContainText("已完成 · 刷新结束");
	await expect(dialog.getByRole("button", { name: "开始刷新", exact: true })).toBeEnabled();
	return finished;
}

test("real unified refresh reloads data, respects stars and supports an unstarred adhoc repository", async ({
	page,
}) => {
	test.setTimeout(120_000);
	const starts: Record<string, unknown>[] = [];
	const writes: string[] = [];
	const reads: string[] = [];
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (!path.startsWith("/api/")) return;
		if (request.method() === "GET") reads.push(path);
		else writes.push(`${request.method()} ${path}`);
		if (path === "/api/refresh-runs" && request.method() === "POST") {
			starts.push(request.postDataJSON() as Record<string, unknown>);
		}
	});
	await page.goto("/settings");
	await page.getByTestId("pat-input").fill(`ghp_${"A".repeat(36)}`);
	await page.getByTestId("pat-submit").click();
	await expect(page.getByTestId("pat-input")).toHaveValue("");
	await expect(page.locator("form").filter({ has: page.getByTestId("pat-input") })).toHaveAttribute(
		"aria-busy",
		"false",
	);
	expect(starts).toEqual([]);
	await page.goto("/repos");
	await page
		.getByRole("group", { name: "仓库范围", exact: true })
		.getByRole("radio", { name: "全部", exact: true })
		.click();
	await expect(page.getByText("暂无已保存的快照", { exact: true })).toBeVisible();
	let dialog = await openRefresh(page);
	await expect(dialog).toContainText("不会自动加星");
	await expect(dialog).toContainText("03:00 Asia/Shanghai");
	await expect(dialog).toContainText("04:30");
	await expect(dialog).toContainText("外部服务");
	await expect(dialog.getByRole("combobox")).toHaveCount(0);
	await expect(dialog.getByText(/快速刷新|深度刷新|完整刷新|每周/)).toHaveCount(0);
	await commitsOnly(dialog);
	const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
	const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
		.toISOString()
		.slice(0, 10);
	await expect(dialog.getByLabel("开始日期", { exact: true })).toHaveValue(yesterday);
	await expect(dialog.getByLabel("结束日期", { exact: true })).toHaveValue(yesterday);
	await expect(dialog.getByLabel("显示时区", { exact: true })).toHaveValue("Asia/Shanghai");
	await expect(
		dialog.getByRole("checkbox", { name: "强制重采已缓存日期", exact: true }),
	).not.toBeChecked();
	const beforeCatalog = reads.filter((path) => path === "/api/repos").length;
	const discovery = await startRefresh(page, dialog, []);
	expect(discovery.requests).toBe(1);
	expect(discovery.requestBreakdown.b).toEqual({ graphql: 0, rest: 0 });
	expect(discovery.params).toEqual({
		since: yesterday,
		until: yesterday,
		timezone: "Asia/Shanghai",
		dimensions: ["commits"],
		force: false,
	});
	expect(starts).toHaveLength(1);
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("repo-list")).toBeVisible();
	await expect
		.poll(() => reads.filter((path) => path === "/api/repos").length)
		.toBeGreaterThan(beforeCatalog);
	const star = page.getByRole("button", { name: `星标 ${repository}`, exact: true });
	await expect(star).toHaveAttribute("aria-pressed", "false");

	dialog = await openRefresh(page);
	await commitsOnly(dialog);
	await startRefresh(page, dialog, []);
	await page.keyboard.press("Escape");
	await expect(star).toHaveAttribute("aria-pressed", "false");
	await star.click();
	await expect(star).toHaveAttribute("aria-pressed", "true");
	await page
		.getByRole("group", { name: "仓库范围", exact: true })
		.getByRole("radio", { name: "星标", exact: true })
		.click();
	await expect(page.getByTestId("repo-list").getByRole("row")).toHaveCount(2);
	dialog = await openRefresh(page);
	await commitsOnly(dialog);
	await startRefresh(page, dialog, [repository]);
	await page.keyboard.press("Escape");
	await expect(star).toHaveAttribute("aria-pressed", "true");
	await star.click();
	await expect(page.getByText("当前星标范围暂无数据", { exact: true })).toBeVisible();

	await page.goto(`/repos/${repository}?tab=factory&stream=dependencies`);
	await expect(page.getByTestId("repo-detail")).toBeVisible();
	await expect(page.getByRole("alert")).toContainText("暂无已保存的资源快照；缺失不代表没有记录。");
	await expect(page.locator(".factory-provenance")).toHaveCount(0);
	const beforeDetail = reads.filter(
		(path) => path === `/api/factory/repos/${repository}/dependencies`,
	).length;
	dialog = await openRefresh(page, true);
	await expect(dialog).toContainText(`仅刷新 ${repository}，不改变星标`);
	await expect(dialog).toContainText("依赖分析不采集，缺失保持 —");
	await commitsOnly(dialog);
	await dialog.getByRole("checkbox", { name: "强制重采已缓存日期", exact: true }).check();
	const adhoc = await startRefresh(page, dialog, [repository], true);
	expect(adhoc.params.repo).toBe(repository);
	expect(adhoc.params.force).toBe(true);
	await page.keyboard.press("Escape");
	await expect
		.poll(
			() => reads.filter((path) => path === `/api/factory/repos/${repository}/dependencies`).length,
		)
		.toBeGreaterThan(beforeDetail);
	const factoryResponse = await page.request.get("/api/factory?scope=all");
	expect(factoryResponse.ok()).toBe(true);
	const factory = (await factoryResponse.json()) as FactoryViewSnapshot;
	expect(factory.repos[0]?.coverage.dependencies.status).toBe("unavailable");
	expect(factory.repos[0]?.metrics.commits).toBe(2);
	expect(factory.window.timezone).toBe("Asia/Shanghai");
	await page.screenshot({
		path: test.info().outputPath("refresh-missing-dependencies.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.goto("/repos");
	await expect(page.getByText("当前星标范围暂无数据", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "查看全部仓库", exact: true }).click();
	await expect(star).toHaveAttribute("aria-pressed", "false");
	await page.goto("/factory");
	await page
		.getByRole("group", { name: "仓库范围", exact: true })
		.getByRole("radio", { name: "全部", exact: true })
		.click();
	await expect(page.getByRole("heading", { name: "变化 · 最近 1 天", exact: true })).toBeVisible();
	const period = page.locator(".factory-period");
	await period.getByRole("radio", { name: "1 天", exact: true }).click();
	await expect(period.locator("dl > div").first().locator("strong")).toHaveText("2");
	await page.getByText("每日账本 · 可访问的图表数据与趋势核对", { exact: true }).click();
	const nextDay = new Date(Date.parse(yesterday) + 86_400_000).toISOString().slice(0, 10);
	const calendarRow = page.locator("#factory-ledger tr").filter({
		has: page.getByRole("rowheader", {
			name: `${yesterday} 00:00 → ${nextDay} 00:00 (Asia/Shanghai)`,
			exact: true,
		}),
	});
	await expect(calendarRow).toBeVisible();
	await expect(calendarRow.getByRole("cell").first()).toHaveText("2");
	const dependencies = page
		.locator("[data-basalt-surface]")
		.filter({ has: page.getByRole("heading", { name: "依赖与维护", exact: true }) });
	await expect(dependencies).toContainText("依赖分析缺少完整观测，缺失不代表没有依赖。");
	await expect(dependencies).not.toContainText("观测引用边 0");
	await dependencies.screenshot({
		path: test.info().outputPath("refresh-factory-dependencies.png"),
		animations: "disabled",
	});
	expect(starts).toHaveLength(4);
	expect(writes.filter((path) => path.endsWith("/star"))).toHaveLength(2);
	expect(
		writes.filter((path) => /^POST \/api\/(refresh|factory\/runs|agent)(\/|$)/.test(path)),
	).toEqual([]);
	expect(reads).toContain("/api/refresh-runs/latest");
	const latest = await page.request.get("/api/refresh-runs/latest");
	expect(await latest.json()).toMatchObject({
		id: adhoc.id,
		status: "completed",
		params: { repo: repository },
	});
});

test("mobile refresh recovers with GET status reads and reports partial data without duplicate starts", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
	const fixtures: Record<string, unknown> = createUiFixtures();
	let starts = 0;
	let polls = 0;
	let run: RefreshRun | null = null;
	await page.route("**/api/**", (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path === "/api/refresh-runs") {
			if (request.method() === "GET")
				return route.fulfill({ json: { items: run ? [run] : [], collectionAvailable: true } });
			starts++;
			if (starts === 1)
				return route.fulfill({
					status: 503,
					json: { error: { code: "refresh_unavailable", message: "private upstream failure" } },
				});
			run = {
				id: "browser-run",
				accountId: "ui-account",
				params: request.postDataJSON() as RefreshRun["params"],
				trigger: "manual",
				status: "queued",
				phase: "account",
				repos: [repository],
				completedRepos: 0,
				requests: 0,
				requestBreakdown: {
					total: 0,
					graphql: 0,
					rest: 0,
					a: { graphql: 0, rest: 0 },
					b: { graphql: 0, rest: 0 },
				},
				partialReasons: [],
				cancelRequested: false,
				partial: false,
				errorCode: null,
				createdAt: "2026-10-28T00:00:00Z",
				updatedAt: "2026-10-28T00:00:00Z",
				finishedAt: null,
			};
			return route.fulfill({ status: 202, json: run });
		}
		if (path === "/api/refresh-runs/browser-run" && run) {
			polls++;
			run =
				polls === 1
					? { ...run, status: "running", phase: "repos" }
					: {
							...run,
							status: "partial",
							phase: "done",
							completedRepos: 1,
							partial: true,
							partialReasons: [{ repo: repository, codes: ["github_unavailable"] }],
							errorCode: "github_unavailable",
							finishedAt: "2026-10-28T00:00:10Z",
						};
			return route.fulfill({ json: run });
		}
		const body = fixtures[path];
		return body
			? route.fulfill({ json: body })
			: route.fulfill({
					status: 409,
					json: { error: { code: "snapshot_missing", message: "No saved fixture" } },
				});
	});
	await page.goto("/repos/octocat/hello-world");
	const dialog = await openRefresh(page);
	await dialog.getByRole("button", { name: "开始刷新", exact: true }).click();
	await expect(dialog.getByRole("alert")).toContainText("无法读取或启动刷新，请重试读取状态。");
	await expect(dialog).not.toContainText("private upstream failure");
	await expect(dialog.getByRole("button", { name: "开始刷新", exact: true })).toBeDisabled();
	await dialog.getByRole("button", { name: "重试读取状态", exact: true }).click();
	await expect(dialog.getByRole("button", { name: "开始刷新", exact: true })).toBeEnabled();
	expect(starts).toBe(1);
	await dialog.getByRole("button", { name: "开始刷新", exact: true }).click();
	await expect(dialog.getByRole("button", { name: "刷新进行中", exact: true })).toBeDisabled();
	await expect(dialog.getByRole("status")).toContainText("B · 仓库串行刷新 0 / 1", {
		timeout: 10_000,
	});
	await expect(dialog.getByRole("status")).toContainText("部分完成 · 刷新结束", {
		timeout: 10_000,
	});
	await expect(dialog.getByRole("status")).toContainText("错误代码：github_unavailable");
	await expect(dialog.getByRole("status")).toContainText("缺失不代表零");
	await expect(dialog.getByRole("button", { name: "开始刷新", exact: true })).toBeEnabled();
	expect(starts).toBe(2);
	expect(polls).toBe(2);
	expect((await dialog.boundingBox())?.width).toBeLessThanOrEqual(358);
	expect(await page.locator("body").evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
		390,
	);
	await page.screenshot({
		path: test.info().outputPath("refresh-mobile-partial.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.keyboard.press("Escape");
	await expect(page.getByRole("button", { name: "刷新数据", exact: true })).toBeFocused();
});
