import type { CronStatus, RepairProgress } from "@nocoo/giraffe-agent/repair-contracts";
import { expect, test } from "@playwright/test";
import { createUiFixtures } from "./ui-fixtures";

const at = "2026-10-02T08:00:00Z",
	head = "a".repeat(40);
const progress: RepairProgress = {
	schemaVersion: 1,
	id: "repair-1",
	repository: "octocat/hello-world",
	issueNumber: 42,
	title: "Upgrade dependency to 2.0.0",
	issueUrl: "https://github.com/octocat/hello-world/issues/42",
	stage: "blocked",
	round: 0,
	maxRounds: 20,
	branch: "giraffe/deps-42-fixture",
	head: null,
	contentFingerprint: null,
	workerConversationId: 7,
	reviewerConversationId: 1,
	startedAt: at,
	updatedAt: at,
	sequence: 3,
	reason: "Verified sandbox unavailable. Docker daemon is not running.",
	plan: {
		decision: "repair",
		reason: "Explicit dependency upgrade request.",
		manifest: "package.json",
		section: "dependencies",
		dependency: "demo",
		targetVersion: "2.0.0",
		provenance: "original",
		provenanceReason: "Owner-maintained repository.",
	},
	review: null,
	events: [
		{
			at,
			stage: "discovered",
			round: 0,
			message: "Issue captured as untrusted data: <script>alert(1)</script>",
		},
		{
			at: "2026-10-02T08:00:01Z",
			stage: "blocked",
			round: 0,
			message: "No verified runner; no repository mutation or push.",
		},
	],
};
const cron: CronStatus = {
	schemaVersion: 1,
	expression: "0 * * * *",
	timezone: "Asia/Shanghai",
	enabled: false,
	paused: true,
	state: "idle",
	nextRunAt: "2026-10-02T09:00:00Z",
	lastRunAt: at,
	activeOccurrence: null,
	lastSeenAt: at,
	completed: 3,
	lastError: null,
	capability: "dependency-upgrades",
	maxRounds: 20,
};
const resource = (
	id: string,
	type: string,
	payload: unknown,
	status = "idle",
	repository: string | null = null,
) => ({
	id,
	type,
	account_id: "ui-account",
	status,
	repository,
	source_version: null,
	payload,
	revision: 1,
	created_at: at,
	updated_at: at,
});
for (const width of [1440, 390])
	for (const theme of ["light", "dark"] as const)
		test(`dependency repair blocked ${width}px ${theme}`, async ({ page }, info) => {
			await page.setViewportSize({ width, height: 1000 });
			await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
			await page.clock.setFixedTime(new Date("2026-10-02T08:01:00Z"));
			const fixtures: Record<string, unknown> = createUiFixtures();
			const writes: Record<string, unknown>[] = [];
			await page.route("**/api/**", (route) => {
				const url = new URL(route.request().url());
				if (url.pathname.includes("/agent/accounts/")) {
					if (route.request().method() === "PATCH") {
						const value = route.request().postDataJSON();
						writes.push(value);
						return route.fulfill({
							json: {
								account_id: "ui-account",
								item: resource("repair-control", "repair-control", value.payload, value.status),
							},
						});
					}
					if (url.pathname.includes("/jobs"))
						return route.fulfill({
							json: {
								account_id: "ui-account",
								items: [
									resource(
										progress.id,
										"dependency-repair",
										progress,
										progress.stage,
										progress.repository,
									),
								],
								nextCursor: null,
							},
						});
					return route.fulfill({
						json: {
							account_id: "ui-account",
							item: url.pathname.endsWith("repair-cron")
								? resource("repair-cron", "repair-cron", cron)
								: resource("repair-control", "repair-control", { paused: true }, "paused"),
						},
					});
				}
				const body = fixtures[url.pathname];
				return body
					? route.fulfill({ json: body })
					: route.fulfill({
							status: 409,
							json: { error: { code: "snapshot_missing", message: "fixture" } },
						});
			});
			await page.goto("/repairs");
			await expect(page.getByTestId("repair-detail")).toContainText(progress.reason);
			await expect(page.getByText("守护进程离线", { exact: true })).toBeVisible();
			await expect(page.getByRole("button", { name: "恢复调度", exact: true })).toBeEnabled();
			await expect(page.getByText("本机授权：未启用")).toBeVisible();
			expect(await page.locator("body").evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(
				width,
			);
			await page.screenshot({ path: info.outputPath(`repairs-${width}-${theme}-top.png`) });
			await page.getByText("提交与会话", { exact: true }).click();
			await expect(page.getByText("Astra 审查会话", { exact: true })).toBeVisible();
			await page.getByRole("heading", { name: "实时事件", exact: false }).scrollIntoViewIfNeeded();
			await page.screenshot({ path: info.outputPath(`repairs-${width}-${theme}-detail.png`) });
			await page.getByRole("button", { name: "恢复调度", exact: true }).click();
			await expect(page.getByRole("status").filter({ hasText: "控制请求已保存" })).toBeVisible();
			expect(writes).toEqual([{ revision: 1, status: "enabled", payload: { paused: false } }]);
			await expect(page.getByText(/等待确认/)).toBeVisible();
			await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
		});
test("twenty rounds exhausted and exact signoff remain distinct from pushed", async ({ page }) => {
	const fixtures: Record<string, unknown> = createUiFixtures();
	const exhausted = {
		...progress,
		id: "exhausted",
		stage: "exhausted",
		round: 20,
		reason: "Maximum review rounds reached.",
	};
	const signed = {
		...progress,
		id: "signed",
		stage: "signed_off",
		round: 2,
		head,
		contentFingerprint: "tree-proof",
		review: {
			verdict: "signoff",
			summary: "Exact code checked.",
			findings: [],
			head,
			contentFingerprint: "tree-proof",
			validationDigest: "checks-proof",
			reviewedRound: 2,
		},
	};
	await page.route("**/api/**", (route) => {
		const url = new URL(route.request().url());
		if (url.pathname.includes("/agent/accounts/"))
			return url.pathname.includes("/jobs")
				? route.fulfill({
						json: {
							account_id: "ui-account",
							items: [
								resource(
									"exhausted",
									"dependency-repair",
									exhausted,
									"exhausted",
									progress.repository,
								),
								resource("signed", "dependency-repair", signed, "signed_off", progress.repository),
							],
							nextCursor: null,
						},
					})
				: route.fulfill({
						status: 404,
						json: { error: { code: "not_found", message: "fixture" } },
					});
		return fixtures[url.pathname]
			? route.fulfill({ json: fixtures[url.pathname] })
			: route.fulfill({
					status: 409,
					json: { error: { code: "snapshot_missing", message: "fixture" } },
				});
	});
	await page.goto("/repairs");
	await page.getByRole("button", { name: /轮次耗尽.*20\/20/ }).click();
	await expect(page.getByTestId("repair-detail")).toContainText("已达到轮次上限");
	await page.getByRole("button", { name: /已签核.*2\/20/ }).click();
	await expect(page.getByTestId("repair-detail")).toContainText("精确代码已签核");
	await expect(page.getByTestId("repair-detail")).toContainText(head);
	await expect(page.getByTestId("repair-detail")).toContainText("checks-proof");
	await expect(page.getByRole("link", { name: "专用分支" })).toHaveAttribute(
		"href",
		"https://github.com/octocat/hello-world/tree/giraffe/deps-42-fixture",
	);
});
