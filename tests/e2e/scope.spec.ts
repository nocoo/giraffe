import { expect, type Page, test } from "@playwright/test";
import { factoryFixture } from "../fixtures/factory-snapshot";
import { createUiFixtures } from "./ui-fixtures";

type SeenRequest = { pathname: string; scope: string | null; method: string };
const selectedRepo = "octocat/basalt";
const oldestAt = "2026-09-01T00:00:00.000Z";
const latestAt = "2026-09-08T08:30:00.000Z";

async function mockScope(page: Page, empty = false) {
	const fixtures = createUiFixtures();
	const requests: SeenRequest[] = [];
	let starred = !empty;
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const scope = url.searchParams.get("scope");
		requests.push({ pathname: url.pathname, scope, method: request.method() });
		if (url.pathname.endsWith("/star")) {
			starred = request.postDataJSON().enabled === true;
			return route.fulfill({ json: { account_id: "ui-account" } });
		}
		if (url.pathname.startsWith("/api/notifications/read")) {
			const body = request.postDataJSON();
			const notifications = fixtures["/api/notifications"].notifications
				.filter((row) => scope !== "starred" || row.name_with_owner === selectedRepo)
				.map((row) => ({ ...row, unread: body.id ? row.id !== body.id && row.unread : false }));
			return route.fulfill({ json: { ...fixtures["/api/notifications"], notifications } });
		}
		if (request.method() !== "GET") {
			return route.fulfill({
				status: 405,
				json: { error: { code: "validation_failed", message: "Read-only fixture" } },
			});
		}
		const fresh =
			scope === "starred"
				? {
						oldestAt: starred ? oldestAt : null,
						latestAt: starred ? oldestAt : null,
						total: starred ? 1 : 0,
						missing: 0,
					}
				: { oldestAt, latestAt, total: 4, missing: 1 };
		if (url.pathname === "/api/factory") {
			const snapshot = factoryFixture();
			return route.fulfill({
				json: {
					...snapshot,
					account_id: "ui-account",
					freshness: fresh,
					fetched_at: latestAt,
					repos: snapshot.repos.map((repo) => ({
						...repo,
						name: "octocat/hello-world",
						observation: {
							source: "run",
							version: "older",
							window: snapshot.window,
							refreshedAt: oldestAt,
						},
					})),
				},
			});
		}
		const source: unknown = fixtures[url.pathname as keyof typeof fixtures];
		if (!source || typeof source !== "object") {
			return route.fulfill({
				status: 409,
				json: { error: { code: "snapshot_missing", message: "No fixture snapshot" } },
			});
		}
		if (!scope) return route.fulfill({ json: source });
		const snapshot = { ...source, freshness: fresh, fetched_at: fresh.latestAt ?? "" } as Record<
			string,
			unknown
		>;
		for (const key of [
			"repos",
			"issues",
			"pull_requests",
			"notifications",
			"items",
			"insights",
			"streams",
		]) {
			const rows = snapshot[key];
			if (Array.isArray(rows)) {
				snapshot[key] = rows
					.filter(
						(row) =>
							scope !== "starred" ||
							(starred && (row.name_with_owner ?? row.repo) === selectedRepo),
					)
					.map((row) => ({ ...row, starred: starred && row.name_with_owner === selectedRepo }));
			}
		}
		return route.fulfill({ json: snapshot });
	});
	return requests;
}

const scopeControl = (page: Page) => page.getByRole("group", { name: "仓库范围", exact: true });

test("scope stays inside business content and fits narrow screens", async ({ page }) => {
	await mockScope(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/issues");
	await expect(scopeControl(page).getByRole("radio", { name: "星标", exact: true })).toBeVisible();
	const box = await scopeControl(page).boundingBox();
	expect(box).not.toBeNull();
	expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
	await page.goto("/settings");
	await expect(page.getByRole("heading", { name: "设置", exact: true }).first()).toBeVisible();
	await expect(scopeControl(page)).toHaveCount(0);
});

test("defaults to starred, updates totals and charts, retains session selection without collection", async ({
	page,
}) => {
	const requests = await mockScope(page);
	await page.goto("/issues?retained=yes");
	await expect(scopeControl(page).getByRole("radio", { name: "星标", exact: true })).toBeChecked();
	await expect(page.getByTestId("issue-summary")).toContainText("1个 open Issue");
	await expect(
		page.getByRole("link", { name: "为共享控件补充使用说明", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "优化长标题在窄屏中的展示与键盘导航", exact: true }),
	).toHaveCount(0);
	await scopeControl(page).getByRole("radio", { name: "全部", exact: true }).click();
	await expect(page.getByTestId("issue-summary")).toContainText("3个 open Issue");
	await expect(page).toHaveURL(/\/issues\?retained=yes$/);
	await page.getByRole("button", { name: /^数据更新时间：/ }).click();
	await expect(page.getByRole("dialog", { name: "数据更新时间" })).toContainText("1 项缺少数据");
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Insights", exact: true }).click();
	await expect(scopeControl(page).getByRole("radio", { name: "全部", exact: true })).toBeChecked();
	await expect(page.getByTestId("insight-metrics")).toContainText("3个 open Issue");
	await scopeControl(page).getByRole("radio", { name: "星标", exact: true }).click();
	await expect(page.getByTestId("insight-metrics")).toContainText("1个 open Issue");
	await expect(page.getByTestId("insight-metrics")).toContainText("0个 open PR");
	expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
	for (const pathname of ["/api/issues", "/api/insights", "/api/prs", "/api/ci"]) {
		expect(
			requests.some((request) => request.pathname === pathname && request.scope === "starred"),
		).toBe(true);
	}
});

test("empty starred scope offers an all-data path and star toggles remove rows immediately", async ({
	page,
}) => {
	await mockScope(page, true);
	await page.goto("/");
	await expect(page.getByText("当前星标范围暂无数据", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "查看全部仓库", exact: true }).click();
	await expect(page.getByTestId("repo-list").getByRole("row")).toHaveCount(5);
	await page.getByRole("button", { name: `星标 ${selectedRepo}`, exact: true }).click();
	await expect(
		page.getByRole("button", { name: `星标 ${selectedRepo}`, exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await scopeControl(page).getByRole("radio", { name: "星标", exact: true }).click();
	await expect(page.getByTestId("repo-list").getByRole("row")).toHaveCount(2);
	await page.getByRole("button", { name: `星标 ${selectedRepo}`, exact: true }).click();
	await expect(page.getByRole("button", { name: `星标 ${selectedRepo}`, exact: true })).toHaveCount(
		0,
	);
	await expect(page.getByText("当前星标范围暂无数据", { exact: true })).toBeVisible();
});

test("background and focus reads preserve UI filters and never collect", async ({ page }) => {
	const requests = await mockScope(page);
	await page.clock.install({ time: new Date("2026-10-01T00:00:00Z") });
	await page.goto("/issues");
	await page.getByRole("searchbox", { name: "搜索 Issues", exact: true }).fill("说明");
	const issueReads = () => requests.filter((request) => request.pathname === "/api/issues").length;
	const before = issueReads();
	await page.clock.fastForward(60_000);
	await expect.poll(issueReads).toBeGreaterThan(before);
	await expect(page.getByRole("searchbox", { name: "搜索 Issues", exact: true })).toHaveValue(
		"说明",
	);
	const polled = issueReads();
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect.poll(issueReads).toBeGreaterThan(polled);
	await expect(page.getByRole("searchbox", { name: "搜索 Issues", exact: true })).toHaveValue(
		"说明",
	);
	expect(requests.every((request) => request.method === "GET")).toBe(true);
});

test("notification read actions remain scoped and account-wide read requires All", async ({
	page,
}) => {
	const requests = await mockScope(page);
	await page.goto("/inbox");
	await page.getByRole("button", { name: "当前范围已读", exact: true }).click();
	await expect
		.poll(() =>
			requests.some(
				(request) =>
					request.pathname === "/api/notifications/read-all" && request.scope === "starred",
			),
		)
		.toBe(true);
	await scopeControl(page).getByRole("radio", { name: "全部", exact: true }).click();
	await page.getByRole("button", { name: "账号全部已读", exact: true }).click();
	await expect
		.poll(() =>
			requests.some(
				(request) => request.pathname === "/api/notifications/read-all" && request.scope === "all",
			),
		)
		.toBe(true);
});

test("explicit unstarred repo detail and factory subviews use their own source timestamps", async ({
	page,
}) => {
	const requests = await mockScope(page);
	await page.goto("/repos/octocat/hello-world");
	await expect(page.getByTestId("repo-detail")).toBeVisible();
	await expect(scopeControl(page)).toHaveCount(0);
	await expect
		.poll(() =>
			requests.some((request) => request.pathname === "/api/factory" && request.scope === "all"),
		)
		.toBe(true);
	await page.goto("/factory?repo=octocat%2Fhello-world&stream=prs&period=7");
	const expectActivityTime = async () => {
		await page.getByRole("button", { name: /^数据更新时间：/ }).click();
		const source = page
			.getByRole("dialog", { name: "数据更新时间" })
			.locator("dl > div")
			.filter({ has: page.getByText("活动统计", { exact: true }) });
		await expect(source.locator("time")).toHaveAttribute("datetime", oldestAt);
		await page.keyboard.press("Escape");
	};
	await expectActivityTime();
	await scopeControl(page).getByRole("radio", { name: "全部", exact: true }).click();
	await expect(page).toHaveURL(/repo=octocat%2Fhello-world&stream=prs&period=7$/);
	await expectActivityTime();
	await expect
		.poll(() =>
			requests.some(
				(request) =>
					request.pathname === "/api/factory/repos/octocat/hello-world/prs" &&
					request.scope === "all",
			),
		)
		.toBe(true);
});
