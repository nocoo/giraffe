import { expect, test } from "@playwright/test";
import { refreshReviewRun, uiRefreshReviewFixtures } from "./ui-refresh-review-fixtures";

test("cancelled account closure does not imply completed collection", async ({ page }, info) => {
	await page.setViewportSize({ width: 1280, height: 720 });
	await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
	await page.clock.setFixedTime(new Date("2026-10-23T01:01:20.000Z"));
	const fixtures = uiRefreshReviewFixtures();
	const current = refreshReviewRun();
	const cancelled = {
		...current,
		status: "cancelled",
		phase: "done",
		repos: [],
		completedRepos: 0,
		requests: 0,
		requestBreakdown: {
			total: 0,
			graphql: 0,
			rest: 0,
			a: { graphql: 0, rest: 0 },
			b: { graphql: 0, rest: 0 },
		},
		partial: false,
		partialReasons: [],
		cancelRequested: true,
		finishedAt: current.updatedAt,
		timings: {
			...current.timings,
			a: { ...current.timings.a, finishedAt: current.updatedAt, attempts: 0 },
			repos: [],
		},
	};
	fixtures["/api/refresh-runs"] = { items: [cancelled], collectionAvailable: true };
	fixtures["/api/refresh-runs/latest"] = cancelled;
	fixtures[`/api/refresh-runs/${cancelled.id}`] = cancelled;
	await page.route("**/api/**", (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		return request.method() === "GET" && path in fixtures
			? route.fulfill({ json: fixtures[path] })
			: route.fulfill({ status: 403, json: {} });
	});
	await page.goto("/refresh");
	const account = page.getByRole("list", { name: "刷新阶段" }).locator(":scope > li").first();
	await expect(account).toContainText("已中断");
	await expect(account).toContainText("尝试 0 次");
	await expect(account).toContainText("结束 2026");
	await expect(account).toHaveAttribute("data-complete", "false");
	await expect(page.getByRole("progressbar", { name: "本次刷新进度" })).toHaveAttribute(
		"value",
		"0",
	);
	await page.screenshot({
		path: info.outputPath("cancelled-account-closure.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.locator("details.refresh-diagnostics > summary").click();
	await expect(page.locator("details.refresh-diagnostics")).toContainText(
		"结束时间表示步骤结束，不代表成功完成采集",
	);
});

test("settled refresh dimensions do not claim complete observations", async ({ page }, info) => {
	await page.setViewportSize({ width: 1280, height: 720 });
	await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
	await page.clock.setFixedTime(new Date("2026-10-23T01:01:20.000Z"));
	const fixtures = uiRefreshReviewFixtures();
	const current = refreshReviewRun();
	const completed = {
		...current,
		status: "completed",
		phase: "done",
		repos: ["octocat/hello-world"],
		completedRepos: 1,
		partial: false,
		partialReasons: [],
		finishedAt: current.updatedAt,
	};
	fixtures["/api/refresh-runs"] = { items: [completed], collectionAvailable: true };
	fixtures["/api/refresh-runs/latest"] = completed;
	fixtures[`/api/refresh-runs/${completed.id}`] = completed;
	await page.route("**/api/**", (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		return request.method() === "GET" && path in fixtures
			? route.fulfill({ json: fixtures[path] })
			: route.fulfill({ status: 403, json: {} });
	});
	await page.goto("/refresh");
	const repo = page.locator("details.refresh-run-row").filter({ hasText: "octocat/hello-world" });
	await repo.locator("summary").click();
	const alerts = repo.locator(".refresh-dimension-list > li").filter({ hasText: "依赖告警" });
	await expect(alerts).toContainText("已处理");
	await expect(alerts).not.toContainText("完整");
	await expect(repo.locator('.refresh-mini-dims > [title="依赖告警 · 已处理"]')).toBeVisible();
	const identity = await repo.locator(".refresh-queue-repo").boundingBox();
	const summary = await repo.locator("summary").boundingBox();
	expect(identity?.width).toBeGreaterThanOrEqual(160);
	expect(summary?.height).toBeLessThanOrEqual(120);
	await page.screenshot({
		path: info.outputPath("settled-dimensions.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("refresh history retains runs with unrecorded diagnostics", async ({ page }) => {
	const fixtures = uiRefreshReviewFixtures();
	const current = refreshReviewRun();
	const historical = {
		...current,
		id: "unrecorded-history",
		status: "partial",
		phase: "done",
		completedRepos: 3,
		createdAt: "2026-10-21T01:00:00.000Z",
		finishedAt: "2026-10-21T01:02:00.000Z",
	};
	for (const field of ["partialReasons", "requestBreakdown", "cancelRequested", "timings"])
		Reflect.deleteProperty(historical, field);
	fixtures["/api/refresh-runs"] = { items: [current, historical], collectionAvailable: true };
	await page.route("**/api/**", (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		return request.method() === "GET" && path in fixtures
			? route.fulfill({ json: fixtures[path] })
			: route.fulfill({ status: 403, json: {} });
	});
	await page.goto("/refresh");
	const historyRow = page.getByRole("row").filter({ hasText: "2026年10月21日" });
	await expect(historyRow).toContainText("未记录");
	await historyRow.getByRole("button", { name: /运行详情/ }).click();
	await expect(page.getByRole("region", { name: "逐仓库刷新进度" })).toContainText("结果未记录");
	await expect(page.locator('.refresh-mini-dims > [data-state="complete"]')).toHaveCount(0);
	await expect(page.getByLabel("请求统计", { exact: true })).toContainText("—");
	await expect(page.getByRole("button", { name: "结束本次刷新", exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "回到当前", exact: true }).click();
	await expect(page.getByRole("button", { name: "结束本次刷新", exact: true })).toBeVisible();
});

test("refresh center shows saved steps and history and cancels only the current run", async ({
	page,
}) => {
	const fixtures = uiRefreshReviewFixtures();
	let current = refreshReviewRun();
	const writes: { path: string; method: string; body: unknown }[] = [];
	await page.clock.setFixedTime(new Date("2026-10-23T01:01:20.000Z"));
	await page.route("**/api/**", (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (request.method() !== "GET") {
			writes.push({ path, method: request.method(), body: request.postDataJSON() });
			if (path === `/api/refresh-runs/${current.id}/cancel` && request.method() === "POST") {
				current = { ...current, cancelRequested: true };
				return route.fulfill({ json: current });
			}
			return route.fulfill({
				status: 403,
				json: { error: { code: "unexpected_write", message: "Unexpected fixture mutation" } },
			});
		}
		if (path === `/api/refresh-runs/${current.id}`) return route.fulfill({ json: current });
		return path in fixtures
			? route.fulfill({ json: fixtures[path] })
			: route.fulfill({
					status: 409,
					json: { error: { code: "snapshot_missing", message: "No fixture" } },
				});
	});
	await page.goto("/refresh");
	await expect(page.getByRole("heading", { name: "刷新中心", exact: true })).toBeVisible();
	await expect(page.getByRole("group", { name: "仓库范围", exact: true })).toHaveCount(0);
	await expect(page.getByRole("region", { name: "逐仓库刷新进度" })).toContainText(
		"octocat/basalt",
	);
	const requestCounts = page.getByLabel("请求统计", { exact: true });
	await expect(requestCounts).toContainText("GraphQL");
	await expect(requestCounts).toContainText("REST");
	const partialRepo = page
		.locator("details.refresh-run-row")
		.filter({ hasText: "octocat/hello-world" });
	await partialRepo.locator("summary").click();
	await expect(partialRepo).toContainText("无权限");
	await expect(partialRepo).toContainText("40 秒");
	await expect(
		page.locator("details.refresh-run-row").filter({ hasText: "octocat/field-notes" }),
	).toContainText("待刷新");
	const historyRow = page.getByRole("row").filter({ hasText: "2026年10月22日" });
	await historyRow.getByRole("button", { name: /运行详情/ }).click();
	await expect(page.getByRole("button", { name: "回到当前", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "结束本次刷新", exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "回到当前", exact: true }).click();
	expect(writes).toEqual([]);
	await page.getByRole("button", { name: "结束本次刷新", exact: true }).click();
	await expect(page.getByText("已请求取消", { exact: true })).toBeVisible();
	expect(writes).toEqual([
		{ path: "/api/refresh-runs/refresh-review-current/cancel", method: "POST", body: null },
	]);
});
