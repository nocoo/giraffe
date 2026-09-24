import { expect, test } from "@playwright/test";
import type { FactoryRunResponse } from "../../src/lib/factory-run";
import { REPO_SNAPSHOT_TABS, SITE_SNAPSHOT_KINDS } from "../../src/lib/snapshot-kinds";

test("factory run survives reload, refreshes the whole site and preserves the last snapshot", async ({
	page,
}) => {
	test.setTimeout(180000);
	await page.goto("/settings");
	await page.getByTestId("pat-input").fill(`ghp_${"A".repeat(36)}`);
	await page.getByTestId("pat-submit").click();
	await expect(page.getByTestId("pat-input")).toHaveValue("");
	await expect(page.locator("form").filter({ has: page.getByTestId("pat-input") })).toHaveAttribute(
		"aria-busy",
		"false",
	);
	await page.goto("/factory");
	await page.getByRole("button", { name: "刷新控制台", exact: true }).click();
	await expect(page.getByRole("button", { name: "同步仓库列表" })).toBeEnabled();
	await page.getByRole("button", { name: "同步仓库列表" }).click();
	await expect(page.getByRole("progressbar", { name: "本次刷新进度" })).toHaveAttribute("max", "4");
	await page.reload();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByRole("region", { name: "数据健康与刷新进度" })).toBeVisible();
	await expect
		.poll(
			async () => {
				const state = (await (
					await page.request.get("/api/factory/runs")
				).json()) as FactoryRunResponse;
				return state.current?.status ?? state.history[0]?.status;
			},
			{ timeout: 25000 },
		)
		.toBe("completed");
	const before = await (await page.request.get("/api/factory")).json();
	expect(before.repos).toHaveLength(1);
	await page.getByRole("button", { name: "刷新控制台", exact: true }).click();
	await page.getByRole("button", { name: "更新状态", exact: true }).click();
	await page.getByRole("tab", { name: "发起刷新" }).click();
	await expect(
		page.getByRole("checkbox", { name: "octocat/hello-world", exact: true }),
	).toBeChecked();
	const create = page.getByRole("button", { name: "开始刷新（1）" });
	await expect(create).toBeEnabled({ timeout: 70000 });
	const started = page.waitForResponse(
		(r) => r.url().endsWith("/api/factory/runs") && r.request().method() === "POST",
	);
	await create.click();
	const response = await started;
	expect(response.status()).toBe(202);
	const run = (await response.json()) as { id: string };
	expect(await (await page.request.get("/api/factory")).json()).toEqual(before);
	await page.reload();
	await page.getByRole("button", { name: "刷新控制台", exact: true }).click();
	await page.getByText("运行信息", { exact: true }).click();
	await expect(page.locator("code").getByText(run.id, { exact: true })).toBeVisible();
	await expect(page.getByRole("progressbar", { name: "本次刷新进度" })).toHaveAttribute(
		"max",
		"26",
	);
	await expect
		.poll(
			async () => {
				const state = (await (
					await page.request.get("/api/factory/runs")
				).json()) as FactoryRunResponse;
				return state.history.find((r) => r.id === run.id)?.status;
			},
			{ timeout: 45000 },
		)
		.toBe("completed");
	await page.getByRole("button", { name: "更新状态", exact: true }).click();
	await expect(page.getByRole("progressbar", { name: "本次刷新进度" })).toHaveAttribute(
		"value",
		"26",
	);
	const completed = (await (
		await page.request.get("/api/factory/runs")
	).json()) as FactoryRunResponse;
	expect(
		completed.history
			.find((entry) => entry.id === run.id)
			?.steps.find((step) => step.kind === "assessment"),
	).toMatchObject({ status: "skipped", error: "ai_not_configured" });
	await expect(page.locator(".factory-run-phases>li").filter({ hasText: "AI 分析" })).toContainText(
		"1 步跳过",
	);
	await expect(page.locator(".factory-run-issues")).toHaveCount(0);
	const after = await (await page.request.get("/api/factory")).json();
	expect(after.runId).toBe(run.id);
	expect(after.repos).toHaveLength(1);
	expect(after.repos[0].observation.version).toBe(run.id);
	for (const path of [
		...SITE_SNAPSHOT_KINDS.map((kind) => `/api/${kind}`),
		"/api/insights",
		"/api/digest",
		...REPO_SNAPSHOT_TABS.map(
			(tab) => `/api/repos/octocat/hello-world${tab === "details" ? "" : `/${tab}`}`,
		),
	]) {
		const saved = await page.request.get(path);
		expect(saved.ok(), `${path} is saved by the factory run`).toBe(true);
		expect(await saved.json()).toMatchObject({ account_id: after.account_id, truncated: false });
	}
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.screenshot({ path: ".factory-cache/refresh-v06/local-desktop.png", fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await expect
		.poll(() => page.locator("body").evaluate((el) => el.scrollWidth))
		.toBeLessThanOrEqual(390);
	await page.screenshot({ path: ".factory-cache/refresh-v06/local-mobile.png", fullPage: true });
});
