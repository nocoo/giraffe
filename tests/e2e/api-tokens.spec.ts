import { expect, test } from "@playwright/test";
import { createUiFixtures } from "./ui-fixtures";

for (const width of [1440, 390])
	test(`external bot token lifecycle and retired CLI consent at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 1000 });
		const fixtures: Record<string, unknown> = createUiFixtures();
		let items: Record<string, unknown>[] = [];
		const writes: Record<string, unknown>[] = [];
		const retiredCalls: string[] = [];
		const callbackCalls: string[] = [];
		await page.route("http://127.0.0.1:12345/callback**", (route) => {
			callbackCalls.push(route.request().url());
			return route.fulfill({ status: 400, body: "Retired callback" });
		});
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
			if (["/api/cli/authorize", "/api/v1/auth/exchange"].includes(url.pathname)) {
				retiredCalls.push(req.url());
				return route.fulfill({
					status: 404,
					json: { error: { code: "not_found", message: "Retired endpoint" } },
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
		await expect(page.getByText("外部 Bot API 令牌", { exact: true })).toBeVisible();
		await page.getByRole("combobox", { name: "有效期", exact: true }).click();
		await page.getByRole("option", { name: "90 天", exact: true }).click();
		await page.getByRole("button", { name: "创建令牌", exact: true }).click();
		await expect(page.getByRole("textbox", { name: "新 API 令牌（仅显示一次）" })).toHaveValue(
			"giraffe_fixture_only_once",
		);
		expect(writes.at(-1)).toMatchObject({ label: "External Bot", expires_in_days: 90 });
		await page.getByRole("button", { name: "已保存，隐藏令牌" }).click();
		await expect(page.getByRole("textbox", { name: "新 API 令牌（仅显示一次）" })).toHaveCount(0);
		await page.getByRole("textbox", { name: "External Bot 标签" }).fill("Renamed");
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
		const before = writes.length;
		for (const path of [
			`/authorize?${params}`,
			"/authorize?redirect_uri=https://evil.test/callback",
		]) {
			await page.goto(path);
			await expect(page.getByText("没有这个页面。", { exact: true })).toBeVisible();
			expect(new URL(page.url()).pathname).toBe("/authorize");
			await expect(page.getByRole("button", { name: "同意并返回 CLI" })).toHaveCount(0);
			await expect(page.locator('a[href="/authorize"]')).toHaveCount(0);
			await expect(page.getByRole("textbox", { name: "新 API 令牌（仅显示一次）" })).toHaveCount(0);
			expect(await page.locator("body").textContent()).not.toContain("giraffe_fixture_only_once");
		}
		expect(writes).toHaveLength(before);
		expect(writes.some((r) => r.consent)).toBe(false);
		expect(retiredCalls).toEqual([]);
		expect(callbackCalls).toEqual([]);
		expect(
			await page.evaluate(() =>
				JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
			),
		).not.toContain("giraffe_fixture_only_once");
		expect(await page.locator("body").evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(width);
	});
