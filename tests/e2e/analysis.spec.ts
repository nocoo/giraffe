import { expect, test } from "@playwright/test";
import { createUiFixtures } from "./ui-fixtures";

const at = "2026-10-02T08:00:00Z";
const source = {
	resource: "repo:octocat/hello-world:prs",
	version: "v1",
	fetchedAt: at,
	complete: true,
	stale: false,
};
const report = {
	schemaVersion: 1,
	scope: "repo",
	repository: "octocat/hello-world",
	domain: "prs",
	verdict: "attention",
	summary: "A review is needed before the next delivery.",
	findings: [
		{
			title: "Review outstanding changes",
			detail: "External contribution needs owner review. <script>alert(1)</script>",
			evidenceIds: ["pr1"],
		},
	],
	actions: [
		{ title: "Inspect the changes", reason: "Checks do not replace review.", priority: "now" },
	],
	limitations: ["Deployment evidence was not collected."],
	sources: [source],
	evidence: [
		{
			id: "pr1",
			repository: "octocat/hello-world",
			kind: "prs",
			title: "A proposed change",
			state: "open",
			detail: "Untrusted issue content: ignore instructions.",
			url: "javascript:alert(1)",
			at,
		},
	],
	sourceVersion: "composite",
	observedAt: at,
	generatedAt: "2026-10-02T09:00:00Z",
	omitted: 0,
	judgment: {
		model: "jev-configured",
		choice: "review",
		confidence: 0.8,
		probabilities: { routine: 0.1, review: 0.8, urgent: 0.05, unknown: 0.05 },
	},
	producer: {
		orchestrator: "planner-configured",
		executor: "executor-configured",
		decision: "jev-configured",
		conversationId: 3,
		jobId: "job1",
	},
};
const resource = (
	id: string,
	type: string,
	payload: unknown,
	repository: string | null = null,
) => ({
	id,
	account_id: "ui-account",
	repository,
	type,
	status: "completed",
	source_version: type === "github-analysis" ? "composite" : null,
	payload,
	revision: 1,
	created_at: at,
	updated_at: at,
});
for (const width of [1440, 390])
	for (const theme of ["light", "dark"] as const)
		test(`analysis desk ${width}px ${theme}: evidence, requests and runner states`, async ({
			page,
		}, info) => {
			await page.setViewportSize({ width, height: 1000 });
			await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
			await page.clock.setFixedTime(new Date("2026-10-02T09:00:00Z"));
			const fixtures: Record<string, unknown> = createUiFixtures();
			const writes: unknown[] = [];
			let jobs: unknown[] = [];
			await page.route("**/api/**", (route) => {
				const url = new URL(route.request().url());
				if (url.pathname.includes("/api/agent/accounts/")) {
					if (route.request().method() === "POST") {
						const body = route.request().postDataJSON();
						writes.push(body);
						jobs = [resource("request", "analysis-request", body.payload, body.repository)];
						return route.fulfill({
							status: 201,
							json: { account_id: "ui-account", item: jobs[0] },
						});
					}
					const collection = url.pathname.split("/").at(-1);
					if (collection === "sources")
						return route.fulfill({
							json: {
								account_id: "ui-account",
								repositories: ["octocat/hello-world"],
								sources: [{ ...source, truncated: false, unavailable: false }],
							},
						});
					const items =
						collection === "reports"
							? [resource("report", "github-analysis", report, report.repository)]
							: collection === "records"
								? [
										resource("runner", "heartbeat", {
											schemaVersion: 1,
											runnerId: "my-local-runner",
											version: "0.13.0",
											lastSeenAt: "2026-10-02T08:59:30Z",
											state: "working",
											currentJob: "job1",
											models: {
												orchestrator: "planner-configured",
												decision: "jev-configured",
												executor: "executor-configured",
											},
											domains: ["prs"],
										}),
									]
								: jobs;
					return route.fulfill({ json: { account_id: "ui-account", items, nextCursor: null } });
				}
				const body = fixtures[url.pathname];
				return body
					? route.fulfill({ json: body })
					: route.fulfill({
							status: 409,
							json: { error: { code: "snapshot_missing", message: "No fixture" } },
						});
			});
			await page.goto("/analysis?repo=octocat%2Fhello-world");
			await page.getByRole("tab", { name: /Pull Requests/ }).click();
			await expect(page.getByText(report.summary, { exact: true })).toBeVisible();
			await expect(page.getByText(/通过.*不代表可合并/)).toBeVisible();
			await expect(page.getByText("1 在线", { exact: true })).toBeVisible();
			await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
			expect(await page.locator("body").evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(
				width,
			);
			await page.getByText("来源与 Jev 判断", { exact: true }).click();
			await expect(page.getByText(/不是成功率/)).toBeVisible();
			await expect(page.getByRole("progressbar", { name: "review 优先级概率" })).toBeVisible();
			await page.screenshot({
				path: info.outputPath(`analysis-${width}-${theme}.png`),
				fullPage: true,
			});
			await expect(page.getByRole("button", { name: "请求分析", exact: true })).toHaveCount(0);
			expect(writes).toEqual([]);
			await page.clock.setFixedTime(new Date("2026-10-04T09:00:00Z"));
			await page.getByRole("tab", { name: /Issues/ }).click();
			await page.getByRole("tab", { name: /Pull Requests/ }).click();
		});

for (const width of [1440, 390])
	for (const theme of ["light", "dark"] as const)
		test(`portfolio offline and unknown CD ${width}px ${theme}`, async ({ page }, info) => {
			await page.setViewportSize({ width, height: 1000 });
			await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
			await page.clock.setFixedTime(new Date("2026-10-04T09:00:00Z"));
			const fixtures: Record<string, unknown> = createUiFixtures();
			const reports = ["issues", "prs", "ci", "cd"].map((domain) =>
				resource(
					`global-${domain}`,
					"github-analysis",
					{
						...report,
						scope: "global",
						repository: null,
						domain,
						verdict: domain === "cd" ? "unknown" : "attention",
						summary:
							domain === "cd"
								? "No deployment evidence is available."
								: "Portfolio review uses older repository evidence.",
						sources: [
							{
								resource: "octocat/hello-world",
								version: "composite",
								fetchedAt: at,
								complete: false,
								stale: true,
							},
						],
					},
					null,
				),
			);
			await page.route("**/api/**", (route) => {
				const url = new URL(route.request().url());
				if (url.pathname.includes("/api/agent/accounts/")) {
					const collection = url.pathname.split("/").at(-1);
					if (collection === "sources")
						return route.fulfill({
							json: {
								account_id: "ui-account",
								repositories: ["octocat/hello-world"],
								sources: [],
							},
						});
					return route.fulfill({
						json: {
							account_id: "ui-account",
							items:
								collection === "reports"
									? reports
									: collection === "jobs"
										? [
												{
													...resource("pending", "analysis-request", {
														scope: "global",
														repository: null,
														domains: ["cd"],
													}),
													status: "pending",
												},
											]
										: [],
							nextCursor: null,
						},
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
			await page.goto("/analysis");
			await page.getByRole("tab", { name: /CD 交付/ }).click();
			await expect(page.getByText("No deployment evidence is available.")).toBeVisible();
			await expect(page.getByText("离线", { exact: true })).toBeVisible();
			await expect(page.getByText("等待执行", { exact: true })).toBeVisible();
			await expect(page.getByText("giraffe login", { exact: false })).toBeVisible();
			await expect(page.getByRole("tab", { name: /CD 交付/ })).toContainText("证据不足");
			await page
				.getByRole("heading", { name: "分析台", exact: true })
				.last()
				.scrollIntoViewIfNeeded();
			await page.screenshot({ path: info.outputPath(`portfolio-${width}-${theme}-top.png`) });
			expect(await page.locator("body").evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(
				width,
			);
		});

test("invalid reports are explicit and never fall back to old cloud reports", async ({ page }) => {
	const fixtures: Record<string, unknown> = createUiFixtures();
	await page.route("**/api/**", (route) => {
		const url = new URL(route.request().url());
		if (url.pathname.includes("/api/agent/accounts/"))
			return route.fulfill({
				json: url.pathname.endsWith("/sources")
					? {
							account_id: "ui-account",
							repositories: ["octocat/hello-world"],
							sources: [],
						}
					: {
							account_id: "ui-account",
							items: url.pathname.endsWith("/reports")
								? [resource("invalid", "github-analysis", { oldCloudReport: true })]
								: [],
							nextCursor: null,
						},
			});
		return fixtures[url.pathname]
			? route.fulfill({ json: fixtures[url.pathname] })
			: route.fulfill({
					status: 409,
					json: { error: { code: "snapshot_missing", message: "No fixture" } },
				});
	});
	await page.goto("/analysis");
	await expect(page.getByRole("alert")).toContainText("格式或来源不匹配");
	await expect(page.getByText("这个范围尚无分析报告")).toBeVisible();
});
