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
		test(`analysis desk ${width}px ${theme}: evidence and bot run states`, async ({
			page,
		}, info) => {
			await page.setViewportSize({ width, height: 1000 });
			await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
			await page.clock.setFixedTime(new Date("2026-10-02T09:00:00Z"));
			const fixtures: Record<string, unknown> = createUiFixtures();
			const writes: unknown[] = [];
			const reportReads: string[] = [];
			let jobs: unknown[] = [];
			let externalReport = false;
			let runStatus = "completed";
			const { producer: _producer, ...externalPayload } = report;
			await page.route("**/api/**", (route) => {
				const url = new URL(route.request().url());
				if (url.pathname.includes("/api/agent/accounts/")) {
					if (route.request().method() === "POST") {
						const body = route.request().postDataJSON();
						writes.push(body);
						jobs = [resource("request", "work-run", body.payload, body.repository)];
						return route.fulfill({
							status: 201,
							json: { account_id: "ui-account", item: jobs[0] },
						});
					}
					const collection = url.pathname.split("/").at(-1);
					if (collection === "reports") reportReads.push(url.pathname);
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
							? [
									resource(
										"report",
										"github-analysis",
										externalReport
											? { ...externalPayload, judgment: { model: "grok-bot", choice: "review" } }
											: report,
										report.repository,
									),
								]
							: collection === "records"
								? [
										{
											...resource("grok-bot-run", "grok-bot-run", {
												lastRunAt: at,
												status: runStatus,
												analyzed: 4,
												skipped: 2,
												error:
													runStatus === "failed"
														? "provider_unavailable <script>alert(1)</script>"
														: undefined,
											}),
											status: runStatus,
										},
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
			expect(reportReads.length).toBeGreaterThan(0);
			expect(reportReads.every((path) => path.endsWith("/analysis/reports"))).toBe(true);
			await expect(page.getByText(/通过.*不代表可合并/)).toBeVisible();
			const runPanel = page.getByRole("complementary", { name: "分析运行状态" });
			await expect(runPanel.getByText("已完成", { exact: true })).toBeVisible();
			await expect(runPanel.getByText("4", { exact: true })).toBeVisible();
			await expect(runPanel.getByText("2", { exact: true })).toBeVisible();
			await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
			expect(await page.locator("body").evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(
				width,
			);
			await page.getByText("来源与优先级判断", { exact: true }).click();
			await expect(page.getByText(/不是成功率/)).toBeVisible();
			await expect(page.getByRole("progressbar", { name: "review 优先级概率" })).toBeVisible();
			await page.screenshot({
				path: info.outputPath(`analysis-${width}-${theme}.png`),
				fullPage: true,
			});
			await expect(page.getByRole("button", { name: "请求分析", exact: true })).toHaveCount(0);
			expect(writes).toEqual([]);
			externalReport = true;
			await page.reload();
			await page.getByRole("tab", { name: /Pull Requests/ }).click();
			await expect(page.getByText(report.summary, { exact: true })).toBeVisible();
			await page.getByText("来源与优先级判断", { exact: true }).click();
			await expect(page.getByText(/模型：grok-bot/)).toBeVisible();
			await expect(page.getByText(/判断置信度/)).toHaveCount(0);
			await expect(page.getByRole("progressbar", { name: "review 优先级概率" })).toHaveCount(0);
			await expect(page.getByText(/planner-configured/)).toHaveCount(0);
			await page.clock.setFixedTime(new Date("2026-10-04T09:00:00Z"));
			await page.reload();
			await expect(runPanel.getByText("已逾期", { exact: true })).toBeVisible();
			await expect(runPanel.getByRole("alert")).toContainText("超过 48 小时");
			await page.clock.setFixedTime(new Date("2026-10-02T09:00:00Z"));
			runStatus = "running";
			await page.reload();
			await expect(runPanel.getByText("运行中", { exact: true })).toBeVisible();
			runStatus = "failed";
			await page.reload();
			await expect(runPanel.getByText("失败", { exact: true })).toBeVisible();
			await expect(runPanel.getByRole("alert")).toContainText(
				"provider_unavailable <script>alert(1)</script>",
			);
			expect(writes).toEqual([]);
		});

for (const width of [1440, 390])
	for (const theme of ["light", "dark"] as const)
		test(`portfolio without bot runs and unknown CD ${width}px ${theme}`, async ({
			page,
		}, info) => {
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
													...resource("pending", "work-run", {
														occurrence: "pending",
													}),
													status: "pending",
												},
											]
										: [resource("work-cron", "work-cron", { lastSeenAt: "2026-10-04T09:00:00Z" })],
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
			await expect(page.getByText("尚无有效分析运行记录。", { exact: true })).toBeVisible();
			await expect(page.getByText("等待执行", { exact: true })).toHaveCount(0);
			await expect(page.getByText("giraffe login", { exact: false })).toHaveCount(0);
			await expect(page.getByText("本地执行器", { exact: true })).toHaveCount(0);
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

test("unchanged global reports stay current after refresh and age from the latest source", async ({
	page,
}) => {
	const fixtures: Record<string, unknown> = createUiFixtures();
	const contentVersion = `sha256:${"a".repeat(64)}`;
	const latest = "2026-10-05T09:00:00Z";
	let currentContent = contentVersion;
	const global = {
		...report,
		scope: "global",
		repository: null,
		sources: [{ ...source, resource: "account:prs", contentVersion }],
	};
	await page.clock.setFixedTime(new Date(latest));
	await page.route("**/api/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.includes("/api/agent/accounts/"))
			return route.fulfill({
				json: path.endsWith("/sources")
					? {
							account_id: "ui-account",
							repositories: [report.repository],
							sources: [
								{
									resource: "account:prs",
									version: "refreshed",
									contentVersion: currentContent,
									fetchedAt: latest,
									truncated: false,
									unavailable: false,
								},
							],
						}
					: {
							account_id: "ui-account",
							items: path.endsWith("/reports")
								? [resource("global", "github-analysis", global)]
								: [],
							nextCursor: null,
						},
			});
		return fixtures[path]
			? route.fulfill({ json: fixtures[path] })
			: route.fulfill({
					status: 409,
					json: { error: { code: "snapshot_missing", message: "No fixture" } },
				});
	});
	await page.goto("/analysis");
	const tab = page.getByRole("tab", { name: /Pull Requests/ });
	await expect(tab).toContainText("需关注");
	await tab.click();
	await expect(page.getByText(report.summary, { exact: true })).toBeVisible();
	currentContent = `sha256:${"b".repeat(64)}`;
	await page.reload();
	await expect(tab).toContainText("证据不足");
	currentContent = contentVersion;
	await page.clock.setFixedTime(new Date(Date.parse(latest) + 36 * 3600000 + 1));
	await page.reload();
	await expect(tab).toContainText("证据不足");
});
