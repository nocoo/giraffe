import { readFileSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { ProjectIdentity } from "../../src/lib/project-identity";
import { factoryFixture } from "../fixtures/factory-snapshot";
import { createUiFixtures } from "./ui-fixtures";

const repository = "octocat/hello-world";
const longRepository = "octocat/a-repository-with-a-very-long-name-for-layout-verification";
const imageBody = readFileSync("public/apple-touch-icon.png");

function identity(repo: string, title: string): ProjectIdentity {
	const [owner, name] = repo.split("/");
	if (!owner || !name) throw new Error("Invalid fixture repository");
	return {
		owner,
		repo: name,
		title,
		description: `${title} brings repository activity and project information together.`,
		archived: false,
		github: `https://github.com/${repo}`,
		website: `https://${name}.example.test`,
		url: `https://hexly.ai/projects/${name}`,
		icons: {
			small: `https://cdn.example.test/${repo}/small.png`,
			large: `https://cdn.example.test/${repo}/large.png`,
		},
		navigationIcon: `https://cdn.example.test/${repo}/navigation.png`,
		favicon: `https://cdn.example.test/${repo}/favicon.png`,
	};
}

const hello = identity(repository, "Hello World Studio");
const giraffe = identity("nocoo/giraffe", "Giraffe Console");
const archived = { ...identity("octocat/basalt", "Basalt Library"), archived: true, website: null };
const long = identity(
	longRepository,
	"A project with a deliberately long descriptive identity title",
);

async function mockProjects(
	page: Page,
	options: { brokenImages?: boolean; failure?: boolean } = {},
) {
	const fixtures = createUiFixtures();
	const snapshot = factoryFixture();
	snapshot.account_id = "ui-account";
	snapshot.status = "complete";
	const base = snapshot.repos[0];
	if (!base) throw new Error("Missing factory fixture");
	snapshot.repos = [repository, longRepository].map((name, index) => ({
		...structuredClone(base),
		id: `project-${index}`,
		name,
	}));
	snapshot.inventory.total = snapshot.inventory.scanned = snapshot.repos.length;
	for (const issue of fixtures["/api/issues"].issues) issue.name_with_owner = longRepository;
	for (const pull of fixtures["/api/prs"].pull_requests) pull.name_with_owner = longRepository;
	for (const alert of fixtures["/api/alerts"].items) alert.name_with_owner = longRepository;
	for (const notification of fixtures["/api/notifications"].notifications)
		notification.name_with_owner = longRepository;
	for (const stream of fixtures["/api/ci"].streams) stream.repo = longRepository;
	const pages: Record<string, unknown> = {
		...fixtures,
		"/api/factory": snapshot,
		"/api/factory/runs": {
			account_id: snapshot.account_id,
			serverNow: snapshot.fetched_at,
			current: null,
			history: [],
			catalog: snapshot.repos,
			catalogComplete: true,
			catalogUpdatedAt: snapshot.fetched_at,
			nextAllowedAt: null,
			publication: null,
			repositories: [],
		},
	};
	const projects: Record<string, ProjectIdentity> = {
		[repository]: hello,
		"nocoo/giraffe": giraffe,
		"octocat/basalt": archived,
		[longRepository]: long,
	};
	const requests = new Map<string, number>();
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.pathname.startsWith("/api/projects/")) {
			const key = url.pathname.slice("/api/projects/".length);
			requests.set(key, (requests.get(key) ?? 0) + 1);
			if (options.failure && requests.get(key) === 1)
				return route.fulfill({ status: 503, json: { error: { code: "internal_error" } } });
			return route.fulfill({ json: projects[key] ?? null });
		}
		if (url.pathname.startsWith("/api/"))
			return url.pathname in pages
				? route.fulfill({ json: pages[url.pathname] })
				: route.fulfill({ status: 404, json: { error: { code: "not_found" } } });
		if (url.hostname === "cdn.example.test")
			return options.brokenImages
				? route.fulfill({ status: 404, body: "" })
				: route.fulfill({ contentType: "image/png", body: imageBody });
		if (url.protocol === "https:") return route.fulfill({ status: 204, body: "" });
		return route.continue();
	});
	await page.emulateMedia({ reducedMotion: "reduce" });
	return requests;
}

function summary(page: Page, repo = repository) {
	return page.locator(`[data-project="${repo}"]`);
}

async function expectLinks(container: Locator, project: ProjectIdentity) {
	await expect(container.getByRole("link", { name: "GitHub", exact: true })).toHaveAttribute(
		"href",
		project.github,
	);
	await expect(container.getByRole("link", { name: "项目说明", exact: true })).toHaveAttribute(
		"href",
		project.url,
	);
	if (project.website)
		await expect(container.getByRole("link", { name: "访问站点", exact: true })).toHaveAttribute(
			"href",
			project.website,
		);
	else await expect(container.getByRole("link", { name: "访问站点", exact: true })).toHaveCount(0);
}

async function expectMark(image: Locator, size: number) {
	await image.scrollIntoViewIfNeeded();
	await expect(image).toBeVisible();
	await expect(image).toHaveCSS("object-fit", "contain");
	await expect(image).toHaveCSS("border-radius", "0px");
	await expect(image).toHaveCSS("clip-path", "none");
	await expect(image).toHaveCSS("width", `${size}px`);
	await expect(image).toHaveCSS("height", `${size}px`);
	await expect
		.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0))
		.toBe(true);
	expect(
		await image.evaluate((node: HTMLImageElement) => {
			const bounds = node.getBoundingClientRect();
			return node.naturalWidth >= bounds.width * window.devicePixelRatio;
		}),
	).toBe(true);
	const bounds = await image.evaluate((node) => {
		const imageRect = node.getBoundingClientRect();
		const parent = node.parentElement?.getBoundingClientRect();
		return { image: { left: imageRect.left, right: imageRect.right }, parent };
	});
	expect(bounds.image.left).toBeGreaterThanOrEqual((bounds.parent?.left ?? 0) - 1);
	expect(bounds.image.right).toBeLessThanOrEqual((bounds.parent?.right ?? 0) + 1);
}

test.use({ deviceScaleFactor: 2 });

test("list, grid and detail share project identity without replacing Giraffe branding or refetching", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	const requests = await mockProjects(page);
	await page.goto("/");
	await expect(summary(page).getByText(hello.title, { exact: true })).toBeVisible();
	await expect(summary(page).getByText(repository, { exact: true })).toBeVisible();
	await expect(summary(page).getByText(hello.description, { exact: true })).toBeVisible();
	await expectLinks(summary(page), hello);
	await expectMark(summary(page).locator("img"), 32);
	await expect(summary(page, archived.github.slice("https://github.com/".length))).toContainText(
		"项目已归档",
	);
	await expectLinks(summary(page, "octocat/basalt"), archived);
	await expect(summary(page, "octocat/field-notes")).toContainText("关于设计与开发的日常记录");
	await expect(summary(page, "octocat/field-notes").locator("img")).toHaveCount(0);
	await page.screenshot({ path: ".factory-cache/hexly-desktop-list.png", animations: "disabled" });
	await page.getByRole("radio", { name: "网格", exact: true }).check();
	await expectMark(summary(page).locator("img"), 48);
	await expectLinks(summary(page), hello);
	await page.screenshot({ path: ".factory-cache/hexly-desktop-grid.png", animations: "disabled" });
	await summary(page)
		.getByRole("link", { name: `${hello.title} ${repository}` })
		.click();
	const detail = page.getByTestId("repo-detail");
	await expect(detail.getByRole("heading", { name: `${hello.title} ${repository}` })).toBeVisible();
	await expect(detail.getByText(hello.description, { exact: true })).toBeVisible();
	await expectLinks(detail, hello);
	await expectMark(detail.getByRole("heading", { level: 1 }).locator("img"), 48);
	await expect(page).toHaveTitle(giraffe.title);
	await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", giraffe.favicon);
	await expect(page.locator("aside img")).toHaveAttribute("src", giraffe.navigationIcon);
	await expect(page.locator("aside")).toContainText(giraffe.title);
	await page.getByRole("button", { name: "折叠侧栏", exact: true }).click();
	await expect(page.getByAltText("Giraffe")).toHaveAttribute("src", giraffe.navigationIcon);
	await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
	expect(requests.get(repository)).toBe(1);
	expect(requests.get("nocoo/giraffe")).toBe(1);
	await page.screenshot({
		path: ".factory-cache/hexly-desktop-detail.png",
		animations: "disabled",
	});
});

test("project identity remains available before repository snapshots exist", async ({ page }) => {
	await mockProjects(page);
	await page.route(`**/api/repos/${repository}`, (route) =>
		route.fulfill({ status: 404, json: { error: { code: "snapshot_missing" } } }),
	);
	await page.goto(`/repos/${repository}`);
	await expect(page.getByRole("heading", { name: `${hello.title} ${repository}` })).toBeVisible();
	await expect(page.getByText(hello.description, { exact: true })).toBeVisible();
	await expect(page.getByText("等待统一刷新", { exact: true })).toBeVisible();
	await expectLinks(page.locator("main"), hello);
	await expectMark(page.getByRole("heading", { level: 1 }).locator("img"), 48);
});

test("temporary lookup failures retain repository content and retry on the next surface", async ({
	page,
}) => {
	const requests = await mockProjects(page, { failure: true });
	await page.goto("/");
	await expect(summary(page).getByText(repository, { exact: true })).toBeVisible();
	await expect(summary(page)).toContainText("A demo repo");
	await expect(summary(page)).not.toContainText(hello.title);
	await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/logo-32.png");
	await expect(page.locator("aside img")).toHaveAttribute("src", "/logo-24.png");
	await page.getByRole("radio", { name: "网格", exact: true }).check();
	await expect(summary(page)).toContainText(hello.title);
	expect(requests.get(repository)).toBe(2);
	await expect(summary(page, "octocat/field-notes")).toContainText("关于设计与开发的日常记录");
	expect(requests.get("octocat/field-notes")).toBe(2);
});

test("archived project details omit an unavailable website and preserve the repository destination", async ({
	page,
}) => {
	await mockProjects(page);
	await page.route("**/api/projects/octocat/hello-world", (route) =>
		route.fulfill({ json: { ...hello, archived: true, website: null } }),
	);
	await page.goto(`/repos/${repository}`);
	const detail = page.getByTestId("repo-detail");
	await expect(detail.getByText("项目已归档", { exact: true })).toBeVisible();
	await expect(detail.getByRole("heading", { name: `${hello.title} ${repository}` })).toBeVisible();
	await expectLinks(detail, { ...hello, archived: true, website: null });
});

test("broken CDN artwork uses a neutral repository mark and the local Giraffe icon", async ({
	page,
}) => {
	await mockProjects(page, { brokenImages: true });
	await page.goto("/");
	await expect(summary(page)).toContainText(hello.title);
	await summary(page).scrollIntoViewIfNeeded();
	await expect(summary(page).locator("img")).toHaveCount(0);
	await expect(summary(page).locator("svg.lucide-box")).toBeVisible();
	await expect(page.locator("aside img")).toHaveAttribute("src", "/logo-24.png");
	await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/logo-32.png");
});

for (const width of [390, 1440]) {
	for (const theme of ["light", "dark"] as const) {
		test(`${width}px ${theme}: project marks and long identities fit cards, detail and secondary surfaces`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
			await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
			await mockProjects(page);
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.goto("/");
			await page.getByRole("radio", { name: "网格", exact: true }).check();
			await expect(summary(page, longRepository)).toContainText(long.title);
			await expectMark(summary(page, longRepository).locator("img"), 48);
			const card = summary(page, longRepository);
			expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
			await page.screenshot({
				path: `.factory-cache/hexly-${width}-${theme}-grid.png`,
				animations: "disabled",
			});
			await summary(page)
				.getByRole("link", { name: `${hello.title} ${repository}` })
				.click();
			await expectMark(page.getByRole("heading", { level: 1 }).locator("img"), 48);
			await expectLinks(page.getByTestId("repo-detail"), hello);
			await page.screenshot({
				path: `.factory-cache/hexly-${width}-${theme}-detail.png`,
				animations: "disabled",
			});
			for (const [path, ready] of [
				["/issues", "issue-list"],
				["/pulls", "pr-list"],
				["/alerts", "alert-list"],
				["/inbox", "inbox-list"],
				["/digest", "digest-list"],
				["/ci", "ci-list"],
			] as const) {
				await page.goto(path);
				const table = page.getByTestId(ready);
				await expect(table).toBeVisible();
				await expectMark(table.locator(`a[href="/repos/${longRepository}"] img`).first(), 24);
				expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
					width,
				);
			}
			await page.goto("/insights");
			const map = page.getByRole("list", { name: "仓库健康地图" });
			const tile = map.locator(`a[href="/repos/${longRepository}"]`);
			await expectMark(tile.locator("img"), 24);
			expect(await tile.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
			const tileName = tile.getByText(longRepository.split("/").at(-1) ?? "", { exact: true });
			expect(
				await tileName.evaluate(
					(node) =>
						node.scrollWidth <= node.clientWidth ||
						getComputedStyle(node).textOverflow === "ellipsis",
				),
			).toBe(true);
			await page.screenshot({
				path: `.factory-cache/hexly-${width}-${theme}-insights.png`,
				animations: "disabled",
			});
			await page.goto("/factory");
			const row = page.getByRole("row").filter({ hasText: longRepository });
			await expectMark(row.locator("img"), 24);
			expect((await row.boundingBox())?.height).toBeLessThan(140);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				width,
			);
			expect(errors).toEqual([]);
			await page.screenshot({
				path: `.factory-cache/hexly-${width}-${theme}-factory.png`,
				animations: "disabled",
			});
		});
	}
}
