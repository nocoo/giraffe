import { expect, test } from "@playwright/test";
import { createUiFixtures } from "./ui-fixtures";

test("Agent visualizes architecture, safe history and revisioned pause on desktop and mobile", async ({
	page,
}) => {
	const fixtures: Record<string, unknown> = createUiFixtures();
	const at = new Date().toISOString();
	const earlier = new Date(Date.now() - 3600000).toISOString();
	const resource = (
		id: string,
		type: string,
		payload: Record<string, unknown>,
		created = at,
		status = "completed",
	) => ({
		id,
		type,
		payload,
		account_id: "ui-account",
		status,
		repository: null,
		source_version: null,
		revision: 1,
		created_at: created,
		updated_at: at,
	});
	let newer = false;
	let paused = false;
	let failPause = false;
	let writes = 0;
	let offline = false;
	const history = resource(
		"old",
		"work-run",
		{
			occurrence: "opaque-old",
			updatedAt: earlier,
			events: [
				"[主控] API 快照：12 个自有仓库，3 条 Issue，2 条 PR",
				"[Jev 优先级] 批次 1/1",
				"[常驻 issues 会话 1] bun run canary",
				"[常驻 prs 会话 2] report",
				"[常驻 ci 会话 3] report",
				"[常驻 cd 会话 4] report",
				"[主控] 本周期无可执行仓库，保存分析后完成。",
				"<script>canary</script>",
			],
			repositories: {},
		},
		earlier,
	);
	const progress = {
		tasks: ["dependency:12", "pr:34", "ci:37090299284"],
		worker: 7,
		reviewer: 8,
		workerModel: "gpt-6-astra / high",
		reviewerModel: "gpt-6-sol / medium",
		round: 4,
		findings: ["test failed: bun run canary"],
		head: "private-head",
		status: "reviewing",
	};
	const current = resource(
		"new",
		"work-run",
		{
			occurrence: "opaque-new",
			updatedAt: at,
			events: [
				"[独立审查 8] round=4 findings=bun run canary",
				"[推送跟进] raw output",
				"rm -rf /private-canary",
			],
			repositories: {
				"owner/repo": progress,
				"owner/published": {
					...progress,
					status: "signed_off",
					followup: { checks: 1, outcome: "pending" },
				},
				"owner/blocked": { ...progress, status: "exhausted", round: 20 },
			},
		},
		at,
		"running",
	);
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path.includes("/agent/accounts/")) {
			if (request.method() !== "GET") {
				writes++;
				expect(path).toContain("/records");
				expect(request.postDataJSON()).toMatchObject({ payload: { paused: true } });
				if (failPause)
					return route.fulfill({
						status: 409,
						json: { error: { code: "account_conflict", message: "canary" } },
					});
				paused = true;
				return route.fulfill({
					json: {
						account_id: "ui-account",
						item: resource("work-control", "work-control", { paused: true }),
					},
				});
			}
			if (path.includes("/jobs"))
				return route.fulfill({
					json: {
						account_id: "ui-account",
						items: newer ? [current, history] : [history],
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
							paused,
							state: newer ? "running" : "idle",
							nextRunAt: at,
							lastRunAt: at,
							activeOccurrence: newer ? "opaque-new" : null,
							lastSeenAt: new Date(Date.now() - (offline ? 60000 : 0)).toISOString(),
							completed: 2,
							lastError: null,
							capability: "authorized-work",
							maxRounds: 20,
						}),
					},
				});
			if (path.endsWith("work-control"))
				return route.fulfill({
					json: {
						account_id: "ui-account",
						item: resource("work-control", "work-control", { paused }),
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
	await page.setViewportSize({ width: 1440, height: 1080 });
	await page.goto("/work");
	await expect(page.getByRole("heading", { name: "Agent", exact: true }).last()).toBeVisible();
	await expect(
		page.getByText("本周期没有可执行仓库，分析记录仍可查看。", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: /Web 观察/ }).focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("region", { name: "节点详情" })).toContainText(
		"读取已保存的 Web 快照",
	);
	await page.screenshot({ path: "/tmp/giraffe-agent-idle-light.png", fullPage: true });
	await page.locator(".agent-history-item").first().focus();
	await page.keyboard.press("Enter");
	newer = true;
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(page.locator(".agent-history-item")).toHaveCount(2);
	await expect(page.locator(".agent-run-summary")).toContainText("已完成");
	await page.getByRole("button", { name: "返回实时" }).click();
	await expect(page.locator(".agent-repositories")).toContainText("CI 故障 #37090299284");
	await expect(page.locator(".agent-repositories")).toContainText("达到轮次上限，未推送");
	await expect(page.locator(".agent-repositories")).toContainText("等待验证 · 1/3 次");
	await page.screenshot({ path: "/tmp/giraffe-agent-busy-light.png", fullPage: true });
	for (const width of [1440, 390]) {
		await page.setViewportSize({ width, height: 1080 });
		for (const dark of [false, true]) {
			await page.emulateMedia({ colorScheme: "light" });
			for (let attempts = 0; attempts < 3; attempts++) {
				if (
					(await page.locator("html").evaluate((element) => element.classList.contains("dark"))) ===
					dark
				)
					break;
				await page.getByRole("button", { name: /切换主题/ }).click();
			}
			expect(
				await page.locator("html").evaluate((element) => element.classList.contains("dark")),
			).toBe(dark);
			await page.reload();
			await expect(page.locator(".agent-repositories")).toContainText("owner/repo");
			await page.locator(".agent-desk").evaluate((element) => {
				let ancestor = element.parentElement;
				while (ancestor) {
					ancestor.scrollTop = 0;
					ancestor = ancestor.parentElement;
				}
			});
			if (dark)
				expect(
					await page
						.locator(".agent-node")
						.first()
						.evaluate((element) => getComputedStyle(element).color),
				).toBe("rgb(237, 237, 237)");
			await expect(page.locator(".agent-desk")).not.toContainText(
				/bun run|rm -rf|canary|opaque-|private-head|0 \* \* \* \*/,
			);
			await expect(page.locator(".agent-desk code, .agent-desk pre")).toHaveCount(0);
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
			).toBe(true);
			expect(
				await page
					.locator(".agent-desk")
					.evaluate((element) => element.scrollWidth <= element.clientWidth),
			).toBe(true);
			await page.screenshot({
				path: `/tmp/giraffe-agent-${width}-${dark ? "dark" : "light"}.png`,
				fullPage: true,
			});
			await page.locator(".agent-activities").scrollIntoViewIfNeeded();
			await page.screenshot({
				path: `/tmp/giraffe-agent-${width}-${dark ? "dark" : "light"}-activity.png`,
			});
		}
	}
	failPause = true;
	await page.getByRole("button", { name: "暂停调度", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("控制保存失败");
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(page.getByRole("alert")).toContainText("控制保存失败");
	failPause = false;
	await page.getByRole("button", { name: "暂停调度", exact: true }).click();
	await expect(page.getByText("等待暂停确认", { exact: true })).toBeVisible();
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(page.getByText("调度已暂停", { exact: true })).toBeVisible();
	expect(writes).toBe(2);
	offline = true;
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(page.getByText("本机离线", { exact: true })).toBeVisible();
	await expect(page.locator(".agent-run-summary")).toContainText("执行状态待确认");
});
