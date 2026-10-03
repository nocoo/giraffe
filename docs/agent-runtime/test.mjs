import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";

const url = new URL("./index.html", import.meta.url).href;
let browser;

before(async () => {
	browser = await chromium.launch({ headless: true });
});
after(async () => {
	await browser?.close();
});

async function openPage(context, viewport = { width: 1440, height: 1100 }) {
	const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
	context.after(() => page.close());
	await page.goto(url);
	return page;
}

test("opens offline with a truthful architecture and selectable node details", async (context) => {
	const page = await openPage(context);
	const external = [];
	page.on("request", (request) => {
		if (!request.url().startsWith("file:")) external.push(request.url());
	});
	await page.reload();
	await expect(page).toHaveTitle("Giraffe / Agent Runtime");
	await expect(page.locator("#detail-title")).toHaveText("Astra orchestrator");
	await page.getByRole("button", { name: "Inspect Jev decision layer" }).click();
	await expect(page.locator("#detail-title")).toHaveText("Jev decision layer");
	await expect(page.locator("#detail-body")).toContainText("25 repositories");
	await page.getByRole("button", { name: "Inspect repository workers" }).click();
	await expect(page.locator("#detail-summary")).toContainText("sequentially");
	await expect(page.locator("#detail-source")).toHaveAttribute(
		"href",
		"../../packages/agent/src/work-coordinator.ts",
	);
	assert.deepEqual(external, []);
});

test("three modes change tools, commands and publication without executing anything", async (context) => {
	const page = await openPage(context);
	await page.getByRole("button", { name: "07 Publication boundary" }).click();
	await expect(page.locator("#stage-outcome")).toContainText("No push. No issue closure.");
	await expect(page.locator("#command")).toContainText("--no-push");
	await page.getByRole("button", { name: "Dry run", exact: true }).click();
	await expect(page.locator("#command")).toContainText("--dry-run");
	await expect(page.locator("#mode-summary")).toContainText("No workspace tools or online writes");
	await expect(page.locator("#stage-outcome")).toContainText("Rehearsal only");
	await page.getByRole("button", { name: "Publish", exact: true }).click();
	await expect(page.locator("#mode-summary")).toContainText("explicit execution grant");
	await expect(page.locator("#stage-outcome")).toContainText("verify remote SHA");
	assert.equal((await page.locator("#command").textContent()).includes("--no-push"), false);
	await expect(page.locator("#offline-label")).toContainText("OFFLINE EXPLAINER");
});

test("step controls, pause, replay completion and reset stay in sync", async (context) => {
	const page = await openPage(context);
	await page.getByRole("button", { name: "Next step" }).click();
	await expect(page.locator("#step-count")).toHaveText("02 / 08");
	await expect(page.locator("#session-log")).toContainText("25 + 25 + 2");
	await page.getByRole("button", { name: "Previous step" }).click();
	await expect(page.locator("#step-count")).toHaveText("01 / 08");
	await page.getByRole("button", { name: "Play walkthrough" }).click();
	await expect(page.getByRole("button", { name: "Pause walkthrough" })).toBeVisible();
	await page.getByRole("button", { name: "Pause walkthrough" }).click();
	await expect(page.getByRole("button", { name: "Play walkthrough" })).toBeVisible();
	await page.getByRole("button", { name: "07 Publication boundary" }).click();
	await page.getByRole("button", { name: "Play walkthrough" }).click();
	await expect(page.locator("#step-count")).toHaveText("08 / 08", { timeout: 5000 });
	await expect(page.getByRole("button", { name: "Play walkthrough" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Next step" })).toBeDisabled();
	await page.getByRole("button", { name: "Reset walkthrough" }).click();
	await expect(page.locator("#step-count")).toHaveText("01 / 08");
	await expect(page.getByRole("button", { name: "Previous step" })).toBeDisabled();
});

test("recorded evidence is separate from simulation and startup states actual limits", async (context) => {
	const page = await openPage(context);
	await page.getByRole("tab", { name: "Recorded run" }).click();
	await expect(page.locator("#recorded-panel")).toBeVisible();
	await expect(page.locator("#recorded-panel")).toContainText("3be12bb");
	await expect(page.locator("#recorded-panel")).toContainText("b145913");
	await expect(page.locator("#recorded-panel")).toContainText("operator-assisted recovery");
	await page.getByRole("tab", { name: "Illustrated log" }).click();
	await expect(page.locator("#replay-panel")).toBeVisible();
	await page.locator("#startup summary").click();
	await expect(page.locator("#startup")).toContainText("not an installed service");
	await expect(page.locator("#startup")).toContainText("repair");
});

test("supports keyboard selection, mobile layouts and zero browser errors", async (context) => {
	const page = await openPage(context);
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.reload();
	const node = page.getByRole("button", { name: "Inspect runtime state" });
	await node.focus();
	await page.keyboard.press("Enter");
	await expect(page.locator("#detail-title")).toHaveText("Local runtime state");
	await expect(node).toHaveAttribute("aria-pressed", "true");
	for (const width of [320, 390, 768, 1024, 1440]) {
		await page.setViewportSize({ width, height: 1000 });
		assert.equal(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
			true,
			`Unexpected horizontal overflow at ${width}px`,
		);
	}
	await page.getByRole("button", { name: "Copy command" }).click();
	await expect(page.locator("#copy-status")).toContainText(/Copied|Select/);
	assert.deepEqual(errors, []);
});
