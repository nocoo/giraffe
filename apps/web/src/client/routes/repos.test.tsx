// @vitest-environment happy-dom
import { TooltipProvider } from "@nocoo/basalt";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RepoRow } from "../viewmodels/repos";
import { setRepositoryScope } from "../viewmodels/scope";
import { setActiveAccountId } from "../viewmodels/session";
import { ReposPage } from "./repos";

vi.mock("../components/layout/use-project-identity", () => ({
	useProjectIdentity: () => null,
}));

const repo = (name: string, over: Partial<RepoRow> = {}): RepoRow => ({
	name_with_owner: `owner/${name}`,
	name,
	owner_login: "owner",
	description: null,
	stargazer_count: 2,
	fork_count: 1,
	open_issue_count: 3,
	primary_language: "TypeScript",
	pushed_at: "2026-10-21T00:00:00Z",
	visibility: "PUBLIC",
	is_private: false,
	is_archived: false,
	is_fork: false,
	starred: true,
	url: `https://github.com/owner/${name}`,
	...over,
});
const repos = [
	{ ...repo("archived", { is_archived: true }), statistics_enabled: false },
	repo("fork", { is_fork: true }),
	repo("weekly", { starred: false }),
];
let container: HTMLDivElement;
let root: Root;
let writes: { resource: string; body: unknown }[];

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	setActiveAccountId("a");
	writes = [];
	let savedRepos = repos.map((r) => ({ ...r }));
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), "https://giraffe.test");
		if (init?.method === "POST") {
			const body = JSON.parse(String(init.body)) as { account_id: string; enabled: boolean };
			expect(url.pathname).toMatch(/^\/api\/repos\/owner\/[^/]+\/star$/);
			writes.push({ resource: url.pathname, body });
			savedRepos = savedRepos.map((r) =>
				url.pathname === `/api/repos/${r.name_with_owner}/star`
					? { ...r, starred: body.enabled }
					: r,
			);
			return Response.json({ account_id: "a" });
		}
		if (url.pathname === "/api/accounts")
			return Response.json({ accounts: [{ id: "a", login: "owner", is_active: true }] });
		if (url.pathname === "/api/repos")
			return Response.json({
				account_id: "a",
				fetched_at: "2026-10-22T00:00:00Z",
				truncated: false,
				repos:
					url.searchParams.get("scope") === "all"
						? savedRepos
						: savedRepos.filter((r) => r.starred),
			});
		if (url.pathname === "/api/insights") return Response.json({ account_id: "a", insights: [] });
		throw new Error(`Unexpected request: ${String(input)}`);
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	setRepositoryScope("starred");
	setActiveAccountId(null);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function renderRepos(scope: "starred" | "all") {
	setRepositoryScope(scope);
	await act(async () =>
		root.render(
			<MemoryRouter>
				<TooltipProvider>
					<ReposPage />
				</TooltipProvider>
			</MemoryRouter>,
		),
	);
}

it("uses stars alone for daily selection without a statistics switch", async () => {
	await renderRepos("starred");
	expect(container.querySelector('[data-testid="repo-summary"]')?.textContent).toContain("2个仓库");
	expect(container.querySelector('[role="switch"]')).toBeNull();
	expect(container.textContent).not.toContain("参与统计");
	expect(container.textContent).not.toContain("已排除");
	expect(container.textContent).toContain(
		"星标仓库每天刷新；全部自有仓库每周刷新，包含 Fork 和已归档仓库。",
	);
	const star = container.querySelector<HTMLButtonElement>('[aria-label="星标 owner/archived"]');
	expect(star?.getAttribute("aria-pressed")).toBe("true");
	await act(async () => star?.click());
	expect(writes).toEqual([
		{ resource: "/api/repos/owner/archived/star", body: { account_id: "a", enabled: false } },
	]);
	expect(container.querySelector('[aria-label="星标 owner/archived"]')).toBeNull();
	expect(container.querySelector('[data-testid="repo-summary"]')?.textContent).toContain("1个仓库");
});

it("includes weekly-only, archived and fork repositories in both list and grid views", async () => {
	await renderRepos("all");
	const summary = container.querySelector('[data-testid="repo-summary"]')?.textContent;
	expect(summary).toContain("3个仓库");
	expect(summary).toContain("Stars 6");
	expect(summary).toContain("Forks 3");
	expect(summary).toContain("Open Issues 9");
	const grid = [...container.querySelectorAll("button")].find((b) => b.textContent === "网格");
	await act(async () => grid?.click());
	expect(container.querySelectorAll('[aria-label^="星标 owner/"]')).toHaveLength(3);
	expect(container.querySelector('[role="switch"]')).toBeNull();
	const star = container.querySelector<HTMLButtonElement>('[aria-label="星标 owner/archived"]');
	await act(async () => star?.click());
	expect(star?.getAttribute("aria-pressed")).toBe("false");
	expect(container.querySelectorAll('[aria-label^="星标 owner/"]')).toHaveLength(3);
	expect(writes).toEqual([
		{ resource: "/api/repos/owner/archived/star", body: { account_id: "a", enabled: false } },
	]);
});
