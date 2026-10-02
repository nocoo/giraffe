import { expect, test } from "@playwright/test";
import { createUiFixtures } from "./ui-fixtures";

for (const width of [1440, 390])
	test(`web token lifecycle and safe CLI consent at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 1000 });
		const fixtures: Record<string, unknown> = createUiFixtures();
		let items: Record<string, unknown>[] = [];
		const writes: Record<string, unknown>[] = [];
		await page.route("**/api/**", (route) => {
			const req = route.request(),
				url = new URL(req.url());
			if (url.pathname.startsWith("/api/tokens")) {
				if (req.method() === "GET")
					return route.fulfill({ json: { account_id: "ui-account", items } });
				const body = req.postDataJSON() as Record<string, unknown>;
				writes.push(body);
				if (req.method() === "POST") {
					const row = {
						id: "token-1",
						account_id: "ui-account",
						label: body.label,
						scopes: body.scopes,
						creator: "demo@example.test",
						created_at: "2026-10-02T00:00:00Z",
						expires_at: "2026-11-01T00:00:00Z",
						last_used_at: null,
						revoked_at: null,
					};
					items = [row];
					return route.fulfill({
						status: 201,
						json: { ...row, token: "giraffe_fixture_only_once" },
					});
				}
				if (req.method() === "PATCH") {
					items = items.map((r) => ({ ...r, label: body.label, scopes: body.scopes }));
					return route.fulfill({ json: items[0] });
				}
				items = items.map((r) => ({ ...r, revoked_at: "2026-10-02T01:00:00Z" }));
				return route.fulfill({ status: 204 });
			}
			if (url.pathname === "/api/cli/authorize") {
				writes.push(req.postDataJSON());
				return route.fulfill({
					status: 400,
					json: { error: { code: "validation_failed", message: "Fixture stops navigation" } },
				});
			}
			const body = fixtures[url.pathname];
			return body
				? route.fulfill({ json: body })
				: route.fulfill({
						status: 409,
						json: { error: { code: "snapshot_missing", message: "No fixture" } },
					});
		});
		await page.goto("/settings");
		await page.getByRole("button", { name: "创建令牌", exact: true }).click();
		await expect(page.getByRole("textbox", { name: "新 API 令牌（仅显示一次）" })).toHaveValue(
			"giraffe_fixture_only_once",
		);
		await page.getByRole("button", { name: "已保存，隐藏令牌" }).click();
		await expect(page.getByRole("textbox", { name: "新 API 令牌（仅显示一次）" })).toHaveCount(0);
		await page.getByRole("textbox", { name: "Local Agent 标签" }).fill("Renamed");
		await page.getByRole("button", { name: "保存标签与权限" }).click();
		await expect(page.getByRole("textbox", { name: "Renamed 标签" })).toBeVisible();
		await page.getByRole("button", { name: "撤销令牌", exact: true }).click();
		await expect(page.getByText("已撤销", { exact: true })).toBeVisible();
		const params = new URLSearchParams({
			redirect_uri: "http://127.0.0.1:12345/callback",
			state: "state",
			code_challenge: "a".repeat(43),
			code_challenge_method: "S256",
			scopes: "observations:read agent:read agent:write",
		});
		await page.goto(`/authorize?${params}`);
		await expect(page.getByRole("button", { name: "同意并返回 CLI" })).toBeEnabled();
		const before = writes.length;
		expect(writes.some((r) => r.consent)).toBe(false);
		await page.getByRole("button", { name: "同意并返回 CLI" }).click();
		await expect(page.getByRole("alert")).toContainText("授权失败");
		expect(writes.length).toBe(before + 1);
		expect(writes.at(-1)).toMatchObject({
			consent: true,
			state: "state",
			redirect_uri: "http://127.0.0.1:12345/callback",
		});
		await page.goto("/authorize?redirect_uri=https://evil.test/callback");
		await expect(page.getByRole("alert")).toContainText("授权参数无效");
		await expect(page.getByRole("button", { name: "同意并返回 CLI" })).toHaveCount(0);
		expect(await page.locator("body").evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(width);
	});
