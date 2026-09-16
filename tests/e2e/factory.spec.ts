import { expect, test } from "@playwright/test";
import type { FactoryRunResponse } from "../../src/lib/factory-run";

test("factory run survives reload, finishes in the Worker queue and preserves the last snapshot", async ({
	page,
}) => {
	test.setTimeout(120000);
	await page.goto("/settings");
	await page.getByTestId("pat-input").fill(`ghp_${"A".repeat(36)}`);
	await page.getByTestId("pat-submit").click();
	await expect(page.getByTestId("pat-input")).toHaveValue("");
	await expect(page.locator("form[aria-busy]")).toHaveAttribute("aria-busy", "false");
	await page.goto("/factory");
	await expect(page.getByRole("button", { name: "重新发现仓库 / 恢复旧资源" })).toBeEnabled();
	await page.getByRole("button", { name: "重新发现仓库 / 恢复旧资源" }).click();
	await expect(page.getByRole("progressbar", { name: "已完成逻辑步骤" })).toHaveAttribute(
		"max",
		"3",
	);
	await page.reload();
	await expect(page.getByRole("progressbar", { name: "已完成逻辑步骤" })).toHaveAttribute(
		"max",
		"3",
	);
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
	await page.getByRole("button", { name: "检查服务端状态" }).click();
	await page.locator(".factory-run-plan>summary").click();
	await page.getByRole("checkbox", { name: "octocat/hello-world", exact: true }).check();
	const create = page.getByRole("button", { name: "创建刷新计划" });
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
	await expect(page.locator("code").getByText(run.id.slice(0, 8), { exact: true })).toBeVisible();
	await expect(page.getByRole("progressbar", { name: "已完成逻辑步骤" })).toHaveAttribute(
		"max",
		"11",
	);
	await expect
		.poll(
			async () => {
				const state = (await (
					await page.request.get("/api/factory/runs")
				).json()) as FactoryRunResponse;
				return state.history.find((r) => r.id === run.id)?.status;
			},
			{ timeout: 25000 },
		)
		.toBe("completed");
	await page.getByRole("button", { name: "检查服务端状态" }).click();
	await expect(page.getByRole("progressbar", { name: "已完成逻辑步骤" })).toHaveAttribute(
		"value",
		"11",
	);
	const after = await (await page.request.get("/api/factory")).json();
	expect(after.runId).toBe(run.id);
	expect(after.repos).toHaveLength(1);
	expect(after.repos[0].observation.version).toBe(run.id);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.screenshot({ path: ".factory-cache/refresh-v06/local-desktop.png", fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	expect(await page.locator("body").evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({ path: ".factory-cache/refresh-v06/local-mobile.png", fullPage: true });
});
