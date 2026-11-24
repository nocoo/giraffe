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
	expect(runtimeRequests).toEqual([]);
	await page.goto("/repos");
	await expect(page.getByTestId("repo-list")).toBeVisible();
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
		finish();
		await expect(row).toContainText("已读");
		expect(requests).toBe(1);
	} finally {
		finish();
	}
});

test("the redesigned settings form clears a rejected PAT", async ({ page }) => {
	await page.goto("/settings");
	const token = `ghp_${"B".repeat(36)}`;
	await page.getByTestId("pat-input").fill(token);
	await page.getByTestId("pat-submit").click();
	await expect(page.getByTestId("pat-input")).toHaveValue("");
	await expect(page.locator("#pat-error")).toHaveText("令牌无效");
	await expect(page.getByTestId("pat-input")).toHaveAttribute("aria-invalid", "true");
	expect(await page.content()).not.toContain(token);
});
