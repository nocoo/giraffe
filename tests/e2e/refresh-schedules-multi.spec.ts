import { expect, test } from "@playwright/test";
import type { FactoryRunResponse } from "../../apps/web/src/lib/factory-run";
import { defaultSchedule, type RefreshSettings } from "../../apps/web/src/lib/refresh-schedule";
import { createUiFixtures } from "./ui-fixtures";

for (const [width, theme] of [
	[1440, "light"],
	[390, "dark"],
] as const) {
	test(`adds, sorts, persists and removes schedule slots at ${width}px in ${theme}`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 900 });
		await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
		const settings: RefreshSettings = {
			account_id: "ui-account",
			starred: [],
			schedules: (["daily", "weekly", "catalog"] as const).map((kind) => ({
				...defaultSchedule(kind),
				kind,
				nextAt: null,
				lastRunId: null,
				lastError: null,
			})),
		};
		const runs: FactoryRunResponse = {
			account_id: "ui-account",
			serverNow: "2026-10-21T00:00:00Z",
			current: null,
			history: [],
			catalog: [],
			catalogComplete: true,
			catalogUpdatedAt: "2026-10-21T00:00:00Z",
			nextAllowedAt: null,
			publication: null,
			repositories: [],
			storage: { resourceBytes: 0, totalBytes: 0 },
		};
		const fixtures: Record<string, unknown> = {
			...createUiFixtures(),
			"/api/factory/runs": runs,
			"/api/refresh/settings": settings,
			"/api/refresh/times": { account_id: "ui-account", runs: [] },
		};
		let writes = 0;
		let failSave = false;
		await page.route("**/api/**", (route) => {
			const request = route.request(),
				path = new URL(request.url()).pathname;
			if (path.startsWith("/api/refresh/schedules/") && request.method() === "POST") {
				if (failSave)
					return route.fulfill({
						status: 400,
						json: { error: { code: "validation_failed", message: "invalid schedule" } },
					});
				const input = request.postDataJSON();
				expect(input.account_id).toBe("ui-account");
				expect(input.time).toBe(input.times[0]);
				expect(input.times).toEqual([...new Set(input.times)].sort());
				const schedule = settings.schedules.find((row) => path.endsWith(`/${row.kind}`));
				if (!schedule) throw new Error("schedule kind missing");
				Object.assign(schedule, input);
				writes++;
				return route.fulfill({ json: settings });
			}
			return path in fixtures
				? route.fulfill({ json: fixtures[path] })
				: route.fulfill({
						status: 409,
						json: { error: { code: "snapshot_missing", message: "No fixture" } },
					});
		});
		await page.goto("/refresh");
		await page.getByRole("tab", { name: "自动刷新", exact: true }).click();
		await expect(page.getByText(/UTC\+8/)).toBeVisible();
		for (const [kind, label] of [
			["daily", "每日快速刷新"],
			["weekly", "每周深度刷新"],
			["catalog", "每日同步仓库列表"],
		] as const) {
			const first = page.getByLabel(`${label}时间`, { exact: true });
			await expect(
				page.getByRole("button", { name: `${label}移除时间 1`, exact: true }),
			).toBeDisabled();
			await first.fill("19:30");
			await page.getByRole("button", { name: `${label}添加时间`, exact: true }).click();
			await page.getByLabel(`${label}时间 2`, { exact: true }).fill("05:30");
			if (kind === "weekly") {
				await page.getByRole("combobox", { name: "每周日期", exact: true }).click();
				await page.getByRole("option", { name: "周三", exact: true }).click();
			}
			const form = page.locator("form").filter({ has: first });
			await form.getByRole("button", { name: "保存计划", exact: true }).click();
			await expect(form.getByRole("status")).toHaveText("已保存");
			await expect(first).toHaveValue("05:30");
			await expect(page.getByLabel(`${label}时间 2`, { exact: true })).toHaveValue("19:30");
			expect(settings.schedules.find((row) => row.kind === kind)?.times).toEqual([
				"05:30",
				"19:30",
			]);
		}
		expect(writes).toBe(3);
		expect(settings.schedules.find((row) => row.kind === "weekly")?.weekday).toBe(3);
		await page.reload();
		await page.getByRole("tab", { name: "自动刷新", exact: true }).click();
		const daily = page.getByLabel("每日快速刷新时间", { exact: true });
		await expect(daily).toHaveValue("05:30");
		const add = page.getByRole("button", { name: "每日快速刷新添加时间", exact: true });
		for (let slot = 3; slot <= 6; slot++) {
			await add.click();
			await page.getByLabel(`每日快速刷新时间 ${slot}`, { exact: true }).fill(`0${slot}:00`);
		}
		await expect(add).toBeDisabled();
		for (let slot = 6; slot >= 2; slot--)
			await page.getByRole("button", { name: `每日快速刷新移除时间 ${slot}`, exact: true }).click();
		await expect(
			page.getByRole("button", { name: "每日快速刷新移除时间 1", exact: true }),
		).toBeDisabled();
		const form = page.locator("form").filter({ has: daily });
		failSave = true;
		await form.getByRole("button", { name: "保存计划", exact: true }).click();
		await expect(form.getByRole("alert")).toBeVisible();
		await expect(daily).toHaveValue("05:30");
		failSave = false;
		await form.getByRole("button", { name: "保存计划", exact: true }).click();
		await expect(form.getByRole("status")).toHaveText("已保存");
		expect(settings.schedules[0]?.times).toEqual(["05:30"]);
		expect(
			await page.locator("body").evaluate((element) => element.scrollWidth),
		).toBeLessThanOrEqual(width);
	});
}
