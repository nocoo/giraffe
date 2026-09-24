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
				id: "security_urgency",
				question: "Do open security cases require immediate mitigation?",
				evidenceIds: ["security:100"],
				choice: "urgent",
				confidence: 0.87,
				probabilities: { urgent: 0.87, review: 0.08, routine: 0.03, unknown: 0.02 },
				uncertain: false,
			},
			{
				id: "external_pr_review",
				question: "Do external pull requests require technical judgment?",
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

test("judgment labels align and probability bars show uncertainty without implying accuracy", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.route(`**${endpoint}`, (route) => route.fulfill({ json: fixture }));
	const panel = await openAssessment(page);
	const rows = panel.getByTestId("assessment-judgment-row");
	await expect(rows).toHaveCount(2);
	const security = rows.filter({ hasText: "安全风险" });
	const external = rows.filter({ hasText: "外部 PR 审查" });
	for (const row of [security, external]) {
		const bounds = await row.getByTestId("judgment-status").boundingBox();
		const confidence = await row.getByTestId("judgment-confidence").boundingBox();
		expect(bounds).not.toBeNull();
		expect(confidence).not.toBeNull();
		expect(
			Math.abs(
				(bounds?.y ?? 0) +
					(bounds?.height ?? 0) / 2 -
					(confidence?.y ?? 0) -
					(confidence?.height ?? 0) / 2,
			),
		).toBeLessThan(1);
	}
	const columns = await rows.evaluateAll((items) =>
		items.map((item) => ({
			status: item.querySelector('[data-testid="judgment-status"]')?.getBoundingClientRect().x,
			confidence: item.querySelector('[data-testid="judgment-confidence"]')?.getBoundingClientRect()
				.x,
		})),
	);
	expect(columns[0]).toEqual(columns[1]);
	await expect(panel.getByText(/不代表结论正确率/)).toBeVisible();
	await expect(security.getByRole("progressbar", { name: "安全风险置信度" })).toHaveAttribute(
		"aria-valuenow",
		"87",
	);
	await expect(external.getByText("需人工复核", { exact: true })).toBeVisible();
	await external.getByRole("button").click();
	const probabilities = external.getByRole("figure", { name: "外部 PR 审查概率分布" });
	await expect(probabilities).toBeVisible();
	await expect(probabilities.getByText("50%", { exact: true })).toBeVisible();
	const proportions = await probabilities
		.locator("[data-probability]")
		.evaluateAll((bars) =>
			bars.map(
				(bar) =>
					(bar.getBoundingClientRect().width /
						(bar.parentElement?.getBoundingClientRect().width ?? 1)) *
					100,
			),
		);
	for (const [index, expected] of [5, 50, 40, 5].entries()) {
		expect(proportions[index]).toBeCloseTo(expected, 1);
	}
	await expect(panel.getByText(/最近 14 天/)).toHaveCount(0);
});

test("new assessments show their actual two-week focus while retained v1 reports keep their original scope", async ({
	page,
}) => {
	await page.route(`**${endpoint}`, (route) =>
		route.fulfill({
			json: {
				...fixture,
				judgment: {
					...fixture.judgment,
					templateVersion: 2,
					focusWindow: { since: "2026-09-10T08:30:00.000Z", until: "2026-09-24T08:30:00.000Z" },
				},
			},
		}),
	);
	const panel = await openAssessment(page);
	await expect(
		panel.getByText("最近 14 天 · 2026-09-10 — 2026-09-24（UTC）", { exact: true }),
	).toBeVisible();
	await expect(panel.getByText(/安全风险以 Issues 为主要线索/)).toBeVisible();
	await panel.getByRole("heading", { name: "Jev 判断", exact: true }).scrollIntoViewIfNeeded();
	await page.screenshot({
		path: ".factory-cache/assessment-judgment-desktop.png",
		animations: "disabled",
	});
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
	await expect(panel.getByRole("progressbar", { name: "安全风险置信度" })).toHaveAttribute(
		"aria-valuenow",
		"87",
	);
	await expect(panel.getByText("需人工复核", { exact: true })).toBeVisible();
	await panel.getByRole("button", { name: /安全风险/ }).click();
	await expect(
		panel.getByRole("figure", { name: "安全风险概率分布" }).getByText("87%", { exact: true }),
	).toBeVisible();
	await expect(
		panel.getByRole("figure", { name: "安全风险概率分布" }).getByText("2%", { exact: true }),
	).toBeVisible();
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
				error: "ai_invalid_report",
			},
		}),
	);
	const panel = await openAssessment(page);
	await expect(panel.getByText("历史报告", { exact: true })).toBeVisible();
	await expect(panel.getByRole("note")).toContainText("保留上次成功结果");
	await expect(panel.getByText("本次评估失败", { exact: true })).toBeVisible();
	await expect(panel.getByText(fixture.report?.summary ?? "", { exact: true })).toBeVisible();
	await expect(panel.locator("time").last()).toHaveAttribute("datetime", fixture.reportAt ?? "");
	await expect(panel.getByText(/模型返回的判断或报告未通过结构与证据校验/)).toBeVisible();
	await expect(panel.getByRole("link", { name: "检查 AI 设置", exact: true })).toHaveCount(0);
});

test("context overflow explains the input limit without suggesting a key change", async ({
	page,
}) => {
	await page.route(`**${endpoint}`, (route) =>
		route.fulfill({ json: { ...fixture, status: "failed", error: "ai_input_too_large" } }),
	);
	const panel = await openAssessment(page);
	await expect(panel.getByText(/仓库数据超出了模型的上下文限制/)).toBeVisible();
	await expect(panel.getByRole("link", { name: "检查 AI 设置", exact: true })).toHaveCount(0);
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
		const neutral = panel
			.getByRole("group", { name: "判断概况" })
			.getByText("信息不足", { exact: true });
		const contrast = await neutral.evaluate((element) => {
			const luminance = (color: string) => {
				const channels = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((channel) => {
					const value = Number(channel) / 255;
					return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
				});
				return (
					(channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722
				);
			};
			const style = getComputedStyle(element);
			const foreground = luminance(style.color);
			const background = luminance(style.backgroundColor);
			return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
		});
		expect(contrast).toBeGreaterThanOrEqual(4.5);
		await page.screenshot({
			path: `.factory-cache/assessment-${theme}.png`,
			animations: "disabled",
		});
		await panel.getByRole("button", { name: /外部 PR 审查/ }).click();
		await expect(
			panel.getByRole("figure", { name: "外部 PR 审查概率分布" }).getByText("50%", { exact: true }),
		).toBeVisible();
		await panel.getByRole("figure", { name: "外部 PR 审查概率分布" }).scrollIntoViewIfNeeded();
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			390,
		);
		await page.screenshot({
			path: `.factory-cache/assessment-judgment-${theme}.png`,
			animations: "disabled",
		});
	}
});
