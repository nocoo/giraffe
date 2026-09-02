import { expect, test } from "@playwright/test";

const PAT = `ghp_${"A".repeat(36)}`;

test("settings PAT, repo list, and repo detail", async ({ page }) => {
	await page.goto("/settings");
	await page.getByTestId("pat-input").fill(PAT);
	await page.getByTestId("pat-submit").click();
	await expect(page.getByTestId("pat-input")).toHaveValue("");
	await expect(page.locator("body")).not.toContainText(PAT);
	expect(await page.content()).not.toContain(PAT);
	await expect(page.getByText("octocat")).toBeVisible();

	await page.goto("/");
	const list = page.getByTestId("repo-list");
	await expect(list).toBeVisible();
	await expect(list.getByText("octocat/hello-world")).toBeVisible();

	await list.getByRole("link", { name: "octocat/hello-world" }).click();
	const detail = page.getByTestId("repo-detail");
	await expect(detail).toBeVisible();
	await expect(detail).toContainText("A demo repo");
});
