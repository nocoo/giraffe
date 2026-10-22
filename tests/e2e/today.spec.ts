import { expect, type Page, test } from "@playwright/test";
import type { ActivitySnapshot } from "../../apps/web/src/lib/activity-types";
import { activityFixture, activityPr, activityRun } from "./activity-fixtures";
import { createUiFixtures } from "./ui-fixtures";

async function savedActivity(page: Page, snapshot: ActivitySnapshot | null) {
	const fixtures: Record<string, unknown> = createUiFixtures();
	const requests: {
		method: string;
		pathname: string;
		run: string | null;
		repository: string | null;
	}[] = [];
	await page.route("**/api/**", (route) => {
		const request = route.request();
		const url = new URL(request.url());
		requests.push({
			method: request.method(),
			pathname: url.pathname,
			run: url.searchParams.get("run"),
			repository: url.searchParams.get("repository"),
		});
		if (url.pathname === "/api/activity" && snapshot) return route.fulfill({ json: snapshot });
		return url.pathname in fixtures
			? route.fulfill({ json: fixtures[url.pathname] })
			: route.fulfill({
					status: 409,
					json: {
						error: {
							code: url.pathname === "/api/activity" ? "activity_unpublished" : "snapshot_missing",
							message: "No publication",
						},
					},
				});
	});
	return requests;
}

test("today empty window is saved evidence, not a collection request", async ({ page }) => {
	const requests = await savedActivity(page, activityFixture());
	await page.goto("/today");
	await expect(page.getByRole("heading", { name: "今日活动", exact: true })).toBeVisible();
	await expect(page.getByTestId("activity-window")).toContainText("数据时间");
	await expect(page.getByTestId("activity-merged")).toContainText("窗口内没有记录");
	await expect(page.getByRole("group", { name: "仓库范围", exact: true })).toHaveCount(0);
	await expect(
		page.getByRole("complementary").getByRole("button", { name: "今日活动", exact: true }),
	).toHaveAttribute("aria-current", "page");
	await expect(page.getByTestId("activity-contributions")).toContainText("2026-10-22");
	await expect(page.getByTestId("activity-contributions")).toContainText("当天未结束");
	await expect(page.getByTestId("activity-contributions")).toContainText(
		"GitHub reported contributions（请求区间）",
	);
	await expect(page.getByTestId("activity-contributions")).toContainText(
		"GitHub 原生日历（github，未转换时区）",
	);
	expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
	expect(requests.filter((request) => request.pathname === "/api/activity")).toEqual([
		{ method: "GET", pathname: "/api/activity", run: "latest", repository: null },
	]);
});

test("today gap window retains its real bounds and warns about first-run history", async ({
	page,
}) => {
	const snapshot = activityFixture();
	snapshot.window.since = "2026-10-19T21:00:00.000Z";
	snapshot.window.gap = true;
	snapshot.window.first = true;
	await savedActivity(page, snapshot);
	await page.goto("/today");
	const window = page.getByTestId("activity-window");
	await expect(window).toContainText("窗口有间隔");
	await expect(window).toContainText("首次窗口");
	await expect(window.locator("time").first()).toHaveAttribute("datetime", snapshot.window.since);
	await expect(window.locator("time").nth(1)).toHaveAttribute("datetime", snapshot.window.until);
});

test("today truncated and unavailable sources never claim a successful zero", async ({ page }) => {
	const snapshot = activityFixture();
	snapshot.truncated = true;
	const repo = snapshot.repos[0];
	if (!repo) throw new Error("Missing fixture repository");
	repo.prs.merged = null;
	repo.deploy.runs = null;
	snapshot.totals.merged_prs = null;
	await savedActivity(page, snapshot);
	await page.goto("/today");
	await expect(page.getByTestId("activity-window")).toContainText("数据已截断");
	await expect(page.getByTestId("activity-merged")).toContainText("未知");
	await expect(page.getByTestId("activity-deploy")).toContainText("未知");
	await expect(page.getByTestId("activity-releases")).toContainText("不代表窗口内没有活动");
	await expect(page.getByText("窗口内没有记录", { exact: true })).toHaveCount(0);
});

test("today normal activity links into the same repository current-run publication", async ({
	page,
}) => {
	const snapshot = activityFixture();
	const repo = snapshot.repos[0];
	if (!repo) throw new Error("Missing fixture repository");
	repo.prs.merged = [activityPr()];
	repo.prs.opened = [activityPr("82")];
	repo.prs.closed = [activityPr("83")];
	repo.releases = [{ ...activityPr("release"), title: "v0.19.0" }];
	repo.ci_runs = [activityRun()];
	repo.deploy.runs = [activityRun()];
	snapshot.totals.merged_prs = 1;
	const requests = await savedActivity(page, snapshot);
	await page.goto("/today");
	await expect(page.getByTestId("activity-merged")).toContainText(
		"Keep current-run activity readable",
	);
	await expect(page.getByTestId("activity-opened")).toContainText(
		"Keep current-run activity readable",
	);
	await expect(page.getByTestId("activity-closed")).toContainText(
		"Keep current-run activity readable",
	);
	await expect(page.getByTestId("activity-releases")).toContainText("v0.19.0");
	await expect(page.getByTestId("activity-ci")).toContainText("Deploy production");
	await expect(page.getByTestId("activity-deploy")).toContainText("Deploy production");
	const destination = page
		.getByTestId("activity-merged")
		.getByRole("link", { name: /Keep current-run activity readable/ });
	await expect(destination).toHaveAttribute("href", "/repos/octocat/hello-world");
	await destination.click();
	await expect(page).toHaveURL(/\/repos\/octocat\/hello-world$/);
	await expect(page.getByTestId("repo-current-activity")).toContainText("当次活动");
	await expect(page.getByTestId("repo-current-activity")).toContainText(
		"Keep current-run activity readable",
	);
	await expect(page.getByTestId("repo-current-activity")).toContainText("最近成功部署");
	await expect
		.poll(() =>
			requests.some(
				(request) =>
					request.pathname === "/api/activity" &&
					request.repository === "octocat/hello-world" &&
					request.run === "latest",
			),
		)
		.toBe(true);
	expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
});

test("today missing publication is not presented as an empty window", async ({ page }) => {
	await savedActivity(page, null);
	await page.goto("/today");
	await expect(page.getByText("等待活动发布", { exact: true })).toBeVisible();
	await expect(page.getByText("窗口内没有记录", { exact: true })).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
	test(`today remains readable at mobile width in ${theme}`, async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
		await savedActivity(page, activityFixture());
		await page.goto("/today");
		await expect(page.getByTestId("activity-window")).toBeVisible();
		for (const id of ["activity-window", "activity-merged", "activity-contributions"]) {
			const box = await page.getByTestId(id).boundingBox();
			expect(box).not.toBeNull();
			expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
		}
	});
}
