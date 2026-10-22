import { expect, test } from "@playwright/test";
import { createUiFixtures } from "./ui-fixtures";

for (const [width, theme] of [
	[390, "light"],
	[1440, "dark"],
] as const)
	test(`R5 read-only repository state survives missing snapshots at ${width}px ${theme}`, async ({
		page,
	}, info) => {
		await page.setViewportSize({ width, height: 900 });
		await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
		const fixtures: Record<string, unknown> = createUiFixtures();
		const summary = {
			revision: 2,
			updated_at: "2026-10-22T05:30:00Z",
			summary: "Review deployment evidence",
			status: "attention",
		};
		const list = fixtures["/api/repos"] as { repos: Record<string, unknown>[] };
		list.repos[0] = { ...list.repos[0], agent_state: summary };
		const writes: string[] = [];
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		let missing = false;
		await page.route("**/api/**", (route) => {
			const url = new URL(route.request().url());
			if (route.request().method() !== "GET") writes.push(url.pathname);
			if (url.pathname.endsWith("/agent-state"))
				return route.fulfill({
					json: {
						account_id: "ui-account",
						repo: "octocat/hello-world",
						repo_removed: missing,
						...summary,
						updated_by: "agent",
						payload: {
							...summary,
							last_reviewed_at: "2026-10-22T05:00:00Z",
							notes: "<script>alert(1)</script>",
						},
					},
				});
			if (missing && url.pathname === "/api/repos/octocat/hello-world")
				return route.fulfill({
					status: 409,
					json: { error: { code: "snapshot_missing", message: "Not collected" } },
				});
			return url.pathname in fixtures
				? route.fulfill({ json: fixtures[url.pathname] })
				: route.fulfill({
						status: 404,
						json: { error: { code: "not_found", message: "No fixture" } },
					});
		});
		await page.goto("/repos");
		await expect(page.getByLabel("管家状态：attention")).toBeVisible();
		await page.getByRole("radio", { name: "网格", exact: true }).check();
		await expect(page.getByLabel("管家状态：attention")).toBeVisible();
		await page.goto("/repos/octocat/hello-world");
		await expect(page.getByText("Review deployment evidence", { exact: true })).toBeVisible();
		await expect(page.getByText("最近审阅", { exact: true })).toBeVisible();
		await page.screenshot({ path: info.outputPath("agent-state.png"), fullPage: true });
		expect(
			await page.locator("main").evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
		).toBe(true);
		missing = true;
		await page.reload();
		await expect(page.getByText("仓库已移除 · 备注保留", { exact: true })).toBeVisible();
		await expect(page.getByText("Review deployment evidence", { exact: true })).toBeVisible();
		expect(writes).toEqual([]);
		expect(errors).toEqual([]);
	});
