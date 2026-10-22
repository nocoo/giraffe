import { expect, test } from "@playwright/test";
import { createUiFixtures } from "./ui-fixtures";

for (const [width, theme] of [
	[390, "light"],
	[1440, "dark"],
] as const)
	test(`R6 repository creation date and category remain visible at ${width}px ${theme}`, async ({
		page,
	}, info) => {
		await page.setViewportSize({ width, height: 900 });
		await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
		const fixtures: Record<string, unknown> = createUiFixtures();
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		const writes: string[] = [];
		let missing = false;
		await page.route("**/api/**", (route) => {
			const url = new URL(route.request().url());
			if (route.request().method() !== "GET") writes.push(url.pathname);
			if (url.pathname.endsWith("/meta"))
				return route.fulfill({
					json: {
						account_id: "ui-account",
						repo: "octocat/hello-world",
						repo_removed: missing,
						created_at: "2020-06-07T08:00:00Z",
						category: "docs-vault",
						first_seen_at: null,
						archived_at: null,
						deleted_at: null,
						exclusion_reason: null,
						updated_at: "2026-10-22T00:00:00Z",
						field_sources: { created_at: "agent", category: "agent" },
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
		await page.goto("/repos/octocat/hello-world");
		await expect(page.getByText("文档库", { exact: true })).toBeVisible();
		await expect(page.getByText(/2020-06-07/)).toBeVisible();
		await page.getByText("文档库", { exact: true }).scrollIntoViewIfNeeded();
		await page.screenshot({ path: info.outputPath("repo-meta.png"), fullPage: true });
		expect(
			await page.locator("main").evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
		).toBe(true);
		missing = true;
		await page.reload();
		await expect(page.getByText("文档库", { exact: true })).toBeVisible();
		await expect(page.getByText(/2020-06-07/)).toBeVisible();
		expect(writes).toEqual([]);
		expect(errors).toEqual([]);
	});
