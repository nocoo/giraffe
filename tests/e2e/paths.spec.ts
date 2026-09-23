import { expect, test } from "@playwright/test";
import type { FactoryRunResponse } from "../../src/lib/factory-run";

const PAT = `ghp_${"A".repeat(36)}`;

test("settings PAT, unified refresh, repo list, and repo detail", async ({ page }) => {
	test.setTimeout(180000);
	await page.goto("/settings");
	await page.getByTestId("pat-input").fill(PAT);
	await page.getByTestId("pat-submit").click();
	await expect(page.getByTestId("pat-input")).toHaveValue("");
	await expect(page.locator("form").filter({ has: page.getByTestId("pat-input") })).toHaveAttribute(
		"aria-busy",
		"false",
	);
	await expect(page.locator("body")).not.toContainText(PAT);
	expect(await page.content()).not.toContain(PAT);
	await expect(page.getByText("octocat")).toBeVisible();
	// This journey also runs on its own, without the factory smoke's saved data.
	if (!(await page.request.get("/api/repos/octocat/hello-world")).ok()) {
		await page.goto("/factory?refresh=1");
		const state = (await (
			await page.request.get("/api/factory/runs")
		).json()) as FactoryRunResponse;
		if (!state.catalogComplete) {
			const sync = page.getByRole("button", { name: "同步仓库列表", exact: true });
			await expect(sync).toBeEnabled({ timeout: 70000 });
			await sync.click();
			await expect
				.poll(
					async () => {
						const next = (await (
							await page.request.get("/api/factory/runs")
						).json()) as FactoryRunResponse;
						return !next.current && next.catalogComplete;
					},
					{ timeout: 25000 },
				)
				.toBe(true);
		}
		await page.getByRole("button", { name: "更新状态", exact: true }).click();
		await page.getByRole("tab", { name: "发起刷新", exact: true }).click();
		const start = page.getByRole("button", { name: "开始刷新（1）", exact: true });
		await expect(start).toBeEnabled({ timeout: 70000 });
		await start.click();
		await expect
			.poll(
				async () => {
					const next = (await (
						await page.request.get("/api/factory/runs")
					).json()) as FactoryRunResponse;
					return !next.current && next.history[0]?.mode === "refresh" && next.history[0]?.status;
				},
				{ timeout: 45000 },
			)
			.toBe("completed");
	}

	await page.goto("/");
	const list = page.getByTestId("repo-list");
	await expect(list).toBeVisible();
	await expect(list.getByText("octocat/hello-world")).toBeVisible();
	await expect(list.getByRole("columnheader", { name: "可见性", exact: true })).toBeVisible();
	await expect(list.getByRole("columnheader", { name: "归档", exact: true })).toBeVisible();
	const toggle = page.getByRole("switch", { name: "octocat/hello-world 参与统计", exact: true });
	await expect(toggle).toBeChecked();
	await toggle.click();
	await expect(toggle).not.toBeChecked();
	await expect(toggle).toBeEnabled();
	await page.reload();
	await expect(toggle).not.toBeChecked();
	const factory = await page.request.get("/api/factory");
	expect((await factory.json()).repos).toEqual([]);
	await page.goto("/factory");
	await expect(page.locator(".factory-repo-link")).toHaveCount(0);
	await page.goto("/");
	await toggle.click();
	await expect(toggle).toBeChecked();
	await expect(toggle).toBeEnabled();
	expect((await (await page.request.get("/api/factory")).json()).repos).toHaveLength(1);

	await list.getByRole("link", { name: "octocat/hello-world" }).click();
	const detail = page.getByTestId("repo-detail");
	await expect(detail).toBeVisible();
	await expect(detail).toContainText("A demo repo");
});
