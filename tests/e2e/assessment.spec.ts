import { expect, type Page, test } from "@playwright/test";
import type { RepoAssessment } from "../../src/lib/repo-assessment";
import { createUiFixtures } from "./ui-fixtures";

const endpoint = "/api/repos/octocat/hello-world/assessment";
const fixture: RepoAssessment = {
	account_id: "ui-account",
	repo: "octocat/hello-world",
	status: "complete",
	sourceVersion: "factory-v2",
	sourceAt: "2026-09-24T08:30:00.000Z",
	reportVersion: "factory-v2",
	reportAt: "2026-09-24T08:32:00.000Z",
	judgment: {
		templateVersion: 1,
		model: "jev-1",
		judgments: [
			{
				id: "security-urgent",
				question: "安全告警是否需要立即处理？",
				evidenceIds: ["security:100"],
				choice: "urgent",
				confidence: 0.87,
				probabilities: { urgent: 0.87, review: 0.08, routine: 0.03, unknown: 0.02 },
				uncertain: false,
			},
			{
				id: "external-pr",
				question: "外部 PR 是否需要技术判断？",
				evidenceIds: ["pr:80"],
				choice: "review",
				confidence: 0.5,
				probabilities: { urgent: 0.05, review: 0.5, routine: 0.4, unknown: 0.05 },
				uncertain: true,
			},
		],
	},
	report: {
		schemaVersion: 1,
		overall: "attention",
		summary: "交付保持稳定，优先处理依赖风险并审查外部 PR。<img src=x onerror=alert(1)>",
		security: {
			status: "urgent",
			summary: "依赖漏洞需要立即检查。",
			evidenceIds: ["security:100"],
		},
		pullRequests: {
			status: "attention",
			summary: "外部作者的架构调整需要审查。",
			evidenceIds: ["pr:80"],
		},
		issues: { status: "healthy", summary: "新建 Issues 已纳入计划。", evidenceIds: ["issue:41"] },
		delivery: {
			status: "healthy",
			summary: "近期提交和合并节奏稳定。",
			evidenceIds: [],
			trend: "steady",
		},
		actions: [
			{ priority: "later", title: "整理说明文档", reason: "降低后续维护成本。", evidenceIds: [] },
			{
				priority: "now",
				title: "检查漏洞影响",
				reason: "确认依赖的可利用范围。",
				evidenceIds: ["security:100"],
			},
			{
				priority: "next",
				title: "审查外部 PR",
				reason: "合并前确认接口设计。",
				evidenceIds: ["pr:80"],
			},
		],
		limitations: ["Code scanning 为可选能力，未获取其结果不代表没有风险。"],
	},
	error: null,
};

async function mockApi(page: Page) {
	const fixtures: Record<string, unknown> = createUiFixtures();
	await page.route("**/api/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		return path in fixtures
			? route.fulfill({ json: fixtures[path] })
			: route.fulfill({
					status: 404,
					json: { error: { code: "not_found", message: "No fixture" } },
				});
	});
}

async function openAssessment(page: Page) {
	await page.goto("/repos/octocat/hello-world");
	await page.getByRole("tab", { name: "AI 评估", exact: true }).click();
	return page.getByTestId("repo-assessment");
}

test.beforeEach(async ({ page }) => {
	await mockApi(page);
});

test("assessment is lazy, structured, read-only and renders model content as safe text", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	let reads = 0;
	const writes: string[] = [];
	page.on("request", (request) => {
		if (new URL(request.url()).pathname.startsWith("/api/") && request.method() !== "GET") {
			writes.push(request.url());
		}
	});
	await page.route(`**${endpoint}`, (route) => {
		reads += 1;
		return route.fulfill({ json: fixture });
	});
	await page.goto("/repos/octocat/hello-world");
	await expect(page.getByTestId("repo-detail")).toBeVisible();
	expect(reads).toBe(0);
	await page.getByRole("tab", { name: "AI 评估", exact: true }).click();
	const panel = page.getByTestId("repo-assessment");
	await expect(panel.getByText("评估完成", { exact: true })).toBeVisible();
	for (const title of [
		"安全",
		"Pull Requests",
		"Issues",
		"交付节奏",
		"建议行动",
		"评估范围与限制",
		"Jev 判断",
	]) {
		await expect(panel.getByRole("heading", { name: title, exact: true })).toBeVisible();
	}
	await expect(panel.getByText(fixture.report?.summary ?? "", { exact: true })).toBeVisible();
	await expect(panel.locator("img")).toHaveCount(0);
	await expect(panel.locator("time").first()).toHaveAttribute("datetime", fixture.sourceAt ?? "");
	await expect(panel.locator("time").last()).toHaveAttribute("datetime", fixture.reportAt ?? "");
	await expect(panel.locator("ol h4")).toHaveText(["检查漏洞影响", "审查外部 PR", "整理说明文档"]);
	await panel.getByRole("heading", { name: "仓库评估", exact: true }).scrollIntoViewIfNeeded();
	await page.screenshot({ path: ".factory-cache/assessment-desktop.png", animations: "disabled" });
	await expect(panel.getByText("置信度 87%", { exact: true })).toBeVisible();
	await expect(panel.getByText("需人工复核", { exact: true })).toBeVisible();
	await panel.getByRole("button", { name: /安全告警是否需要立即处理/ }).click();
	await expect(panel.getByText("87%（0.87）", { exact: true })).toBeVisible();
	await expect(panel.getByText("2%（0.02）", { exact: true })).toBeVisible();
	await panel.getByRole("button", { name: "参考记录（1）", exact: true }).last().click();
	await expect(panel.getByText("security:100", { exact: true }).last()).toBeVisible();
	expect(reads).toBe(1);
	expect(writes).toEqual([]);
});

test("missing configuration links to settings and absent reports stay quiet", async ({ page }) => {
	await page.route(`**${endpoint}`, (route) =>
		route.fulfill({
			json: { ...fixture, status: "unconfigured", report: null, judgment: null, reportAt: null },
		}),
	);
	const panel = await openAssessment(page);
	await expect(panel.getByText("未配置 AI", { exact: true })).toBeVisible();
	await expect(panel.getByRole("link", { name: "设置", exact: true })).toHaveAttribute(
		"href",
		"/settings",
	);
	await page.unroute(`**${endpoint}`);
	await page.getByRole("tab", { name: "概览", exact: true }).click();
	await page.getByRole("tab", { name: "AI 评估", exact: true }).click();
	await expect(
		panel.getByText("尚未生成评估，将在该仓库下一次成功刷新数据后自动生成。", { exact: true }),
	).toBeVisible();
	await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});

test("only active phases poll and polling stops when the report completes or the tab closes", async ({
	page,
}) => {
	await page.clock.install();
	let reads = 0;
	await page.route(`**${endpoint}`, (route) => {
		reads += 1;
		return route.fulfill({
			json:
				reads === 1
					? { ...fixture, status: "judgment", report: null, judgment: null, reportAt: null }
					: reads === 2
						? { ...fixture, status: "summary", report: null, reportAt: null }
						: fixture,
		});
	});
	const panel = await openAssessment(page);
	await expect(panel.getByText("Jev 正在判断", { exact: true })).toBeVisible();
	await page.clock.runFor(3100);
	await expect(panel.getByText("正在生成报告", { exact: true })).toBeVisible();
	await expect(panel.getByRole("heading", { name: "Jev 判断", exact: true })).toBeVisible();
	await page.clock.runFor(3100);
	await expect(panel.getByText("评估完成", { exact: true })).toBeVisible();
	await page.clock.runFor(10_000);
	expect(reads).toBe(3);
	reads = 0;
	await page.getByRole("tab", { name: "概览", exact: true }).click();
	await page.getByRole("tab", { name: "AI 评估", exact: true }).click();
	await expect(panel.getByText("Jev 正在判断", { exact: true })).toBeVisible();
	await page.getByRole("tab", { name: "概览", exact: true }).click();
	await page.clock.runFor(10_000);
	expect(reads).toBe(1);
});

test("a failed newer assessment preserves the last successful report with its original date", async ({
	page,
}) => {
	await page.route(`**${endpoint}`, (route) =>
		route.fulfill({
			json: {
				...fixture,
				status: "failed",
				sourceVersion: "factory-v3",
				sourceAt: "2026-09-25T08:30:00.000Z",
				error: "summary_invalid",
			},
		}),
	);
	const panel = await openAssessment(page);
	await expect(panel.getByText("历史报告", { exact: true })).toBeVisible();
	await expect(panel.getByRole("note")).toContainText("保留上次成功结果");
	await expect(panel.getByText("本次评估失败", { exact: true })).toBeVisible();
	await expect(panel.getByText(fixture.report?.summary ?? "", { exact: true })).toBeVisible();
	await expect(panel.locator("time").last()).toHaveAttribute("datetime", fixture.reportAt ?? "");
	await expect(panel.getByRole("link", { name: "检查 AI 设置", exact: true })).toHaveAttribute(
		"href",
		"/settings",
	);
});

test("read failures have an inline retry and never start generation", async ({ page }) => {
	let reads = 0;
	await page.route(`**${endpoint}`, (route) => {
		reads += 1;
		expect(route.request().method()).toBe("GET");
		return reads === 1
			? route.fulfill({
					status: 503,
					json: { error: { code: "db_error", message: "Unavailable" } },
				})
			: route.fulfill({ json: fixture });
	});
	const panel = await openAssessment(page);
	await expect(panel.getByRole("alert")).toHaveText("暂时无法读取 AI 评估，请重试。");
	await panel.getByRole("button", { name: "重新读取", exact: true }).click();
	await expect(panel.getByText("评估完成", { exact: true })).toBeVisible();
	await expect(panel.getByRole("alert")).toHaveCount(0);
	expect(reads).toBe(2);
});

test("assessment text, controls and probabilities fit narrow screens in both themes", async ({
	page,
}) => {
	await page.route(`**${endpoint}`, (route) => route.fulfill({ json: fixture }));
	for (const theme of ["light", "dark"]) {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
		const panel = await openAssessment(page);
		await expect(panel.getByText("评估完成", { exact: true })).toBeVisible();
		await page.screenshot({
			path: `.factory-cache/assessment-${theme}.png`,
			animations: "disabled",
		});
		await panel.getByRole("button", { name: /外部 PR 是否需要技术判断/ }).click();
		await expect(panel.getByText("50%（0.5）", { exact: true })).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			390,
		);
		await page.screenshot({
			path: `.factory-cache/assessment-judgment-${theme}.png`,
			animations: "disabled",
		});
	}
});
