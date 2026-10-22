import { expect, test } from "@playwright/test";
import { dailyReport } from "../fixtures/daily-report";

for (const [width, theme] of [
	[390, "light"],
	[1440, "dark"],
] as const)
	test(`R8 posted daily matches latest, browses seven and safely opens Xray at ${width}px ${theme}`, async ({
		page,
		context,
	}, info) => {
		test.setTimeout(120000);
		await page.setViewportSize({ width, height: 1000 });
		await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
		const origin = "https://giraffe.dev.hexly.ai";
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		const accountResponse = await page.request.post("/api/accounts", {
			headers: { origin },
			data: { token: `ghp_${"A".repeat(36)}` },
		});
		expect(accountResponse.ok()).toBe(true);
		const account = (await accountResponse.json()).id as string;
		expect(
			(await page.request.post(`/api/accounts/${account}/activate`, { headers: { origin } })).ok(),
		).toBe(true);
		const minted = await page.request.post("/api/tokens", {
			headers: { origin },
			data: {
				account_id: account,
				label: "daily browser acceptance",
				scopes: ["agent:read", "agent:write"],
				expires_in_days: 1,
			},
		});
		expect(minted.status()).toBe(201);
		const token = (await minted.json()) as { id: string; token: string };
		const headers = { authorization: `Bearer ${token.token}` };
		const prefix = `/api/v1/accounts/${account}/agent/reports`;
		const saved: { id: string; revision: number }[] = [];
		try {
			for (let day = 15; day <= 22; day++) {
				const report = dailyReport(`2026-10-${day}`, `Daily ${day}`);
				const response = await page.request.post(prefix, {
					headers,
					data: { type: report.type, status: report.status, payload: report.payload },
				});
				expect(response.status()).toBe(201);
				saved.push((await response.json()).item);
			}
			const revised = dailyReport("2026-10-22", "Latest daily delivery review");
			const replacement = await page.request.post(prefix, {
				headers,
				data: { type: revised.type, status: revised.status, payload: revised.payload },
			});
			expect(replacement.status()).toBe(200);
			const newest = (await replacement.json()).item;
			saved[saved.length - 1] = newest;
			const latest = await (
				await page.request.get(`${prefix}/latest?type=github-daily`, { headers })
			).json();
			expect(latest.item).toEqual(newest);
			await page.goto("/analysis");
			const card = page.getByTestId("github-daily");
			await expect(
				card.getByRole("heading", { name: latest.item.payload.headline, exact: true }),
			).toBeVisible();
			await expect(page.getByRole("tab", { name: /Issues/ })).toBeVisible();
			await expect(page.getByRole("tab", { name: /Pull Requests/ })).toBeVisible();
			await expect(page.getByRole("tab", { name: /CI 构建/ })).toBeVisible();
			await expect(page.getByRole("tab", { name: /CD 交付/ })).toBeVisible();
			await expect(card.getByText("One fewer failure", { exact: true })).toBeVisible();
			await expect(
				card.getByText("Review changes. <script>alert(1)</script>", { exact: true }),
			).toBeVisible();
			await expect(card.locator("script")).toHaveCount(0);
			await expect(card.getByRole("button", { name: "2026-10-15", exact: true })).toHaveCount(0);
			await card.getByRole("button", { name: "2026-10-16", exact: true }).click();
			await expect(card.getByRole("heading", { name: "Daily 16", exact: true })).toBeVisible();
			await card.getByRole("button", { name: "最新 · 2026-10-22", exact: true }).click();
			await expect(
				card.getByRole("heading", { name: latest.item.payload.headline, exact: true }),
			).toBeVisible();
			const link = card.getByRole("link", { name: "在 Xray 阅读" });
			await expect(link).toHaveAttribute("target", "_blank");
			await expect(link).toHaveAttribute("rel", /noopener/);
			await context.route("https://xray.example/**", (route) =>
				route.fulfill({
					contentType: "text/html",
					body: "<title>Local Xray fixture</title>Daily fixture",
				}),
			);
			const opened = context.waitForEvent("page");
			await link.click();
			const popup = await opened;
			await popup.waitForLoadState();
			expect(popup.url()).toBe(latest.item.payload.links.xray);
			expect(await popup.evaluate(() => window.opener === null)).toBe(true);
			await popup.close();
			const invalid = await page.request.post(prefix, {
				headers,
				data: {
					type: "github-daily",
					status: "completed",
					payload: { ...revised.payload, links: { xray: "javascript:alert(1)" } },
				},
			});
			expect(invalid.status()).toBe(400);
			const historyPath = `/api/agent/accounts/${account}/analysis/daily`;
			const history = await (await page.request.get(historyPath)).json();
			await page.route(`**${historyPath}`, (route) =>
				route.fulfill({
					json: {
						...history,
						invalidCount: 1,
						items: [
							{
								...newest,
								id: "invalid-legacy",
								payload: {
									...revised.payload,
									headline: "Hidden invalid legacy",
									links: { xray: "javascript:alert(1)" },
								},
							},
							...history.items,
						],
					},
				}),
			);
			await page.reload();
			await expect(card.getByRole("alert")).toContainText("2 份无效或旧格式日报");
			await expect(card.getByText("Hidden invalid legacy", { exact: true })).toHaveCount(0);
			await expect(
				card.getByRole("heading", { name: latest.item.payload.headline, exact: true }),
			).toBeVisible();
			await card.scrollIntoViewIfNeeded();
			await page.screenshot({ path: info.outputPath("github-daily.png"), fullPage: true });
			expect(
				await page
					.locator("#main-content")
					.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
			).toBe(true);
			expect(errors).toEqual([]);
		} finally {
			for (const report of saved)
				expect(
					(
						await page.request.delete(`${prefix}/${report.id}?revision=${report.revision}`, {
							headers,
						})
					).status(),
				).toBe(204);
			expect(
				(
					await page.request.delete(`/api/tokens/${token.id}`, {
						headers: { origin },
						data: { account_id: account },
					})
				).status(),
			).toBe(204);
		}
	});
