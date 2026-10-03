import { expect, test } from "@playwright/test";
import { createUiFixtures } from "./ui-fixtures";

test("Work shows persisted rounds, publication follow-up and pause without execution controls", async ({
	page,
}) => {
	const fixtures: Record<string, unknown> = createUiFixtures();
	const at = new Date().toISOString();
	const resource = (id: string, type: string, payload: Record<string, unknown>) => ({
		id,
		type,
		payload,
		account_id: "ui-account",
		status: "completed",
		repository: null,
		source_version: null,
		revision: 1,
		created_at: at,
		updated_at: at,
	});
	await page.route("**/api/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.includes("/agent/accounts/")) {
			if (path.includes("/jobs"))
				return route.fulfill({
					json: {
						account_id: "ui-account",
						items: [
							resource("run", "work-run", {
								occurrence: "cron-one",
								updatedAt: at,
								events: [
									"worker:repo 7 reviewer:repo 8 round=20 findings=unresolved no push",
									"SHA=abc checks=3/3 timeout",
									"<script>alert(1)</script>",
								],
							}),
						],
						nextCursor: null,
					},
				});
			if (path.endsWith("work-cron"))
				return route.fulfill({
					json: {
						account_id: "ui-account",
						item: resource("work-cron", "work-cron", {
							schemaVersion: 1,
							expression: "0 * * * *",
							timezone: "UTC",
							enabled: true,
							paused: false,
							state: "idle",
							nextRunAt: at,
							lastRunAt: at,
							activeOccurrence: null,
							lastSeenAt: at,
							completed: 1,
							lastError: null,
							capability: "authorized-work",
							maxRounds: 20,
						}),
					},
				});
			return route.fulfill({
				status: 404,
				json: { error: { code: "not_found", message: "fixture" } },
			});
		}
		return fixtures[path]
			? route.fulfill({ json: fixtures[path] })
			: route.fulfill({
					status: 409,
					json: { error: { code: "snapshot_missing", message: "fixture" } },
				});
	});
	await page.goto("/repairs");
	await expect(page.getByRole("heading", { name: "Work", exact: true })).toBeVisible();
	await expect(page.getByText("本机在线", { exact: true })).toBeVisible();
	await expect(page.getByText("SHA=abc checks=3/3 timeout")).toBeVisible();
	await expect(page.getByText(/round=20 findings=unresolved no push/)).toBeVisible();
	await expect(page.locator("script").filter({ hasText: "alert(1)" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "暂停调度", exact: true })).toBeEnabled();
});
