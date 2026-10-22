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
	star_source: null,
	star_updated_at: null,
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
	{
		...repo("archived", {
			is_archived: true,
			star_source: "owner",
			star_updated_at: "2026-10-20T00:00:00Z",
		}),
		statistics_enabled: false,
	},
	repo("fork", {
		is_fork: true,
		star_source: "agent",
		star_updated_at: "2026-10-21T00:00:00Z",
	}),
	repo("weekly", { starred: false }),
];
let container: HTMLDivElement;
let root: Root;
let writes: { resource: string; body: unknown }[];
let holdRefetch: boolean;
let failWrite: boolean;
let releaseRefetch: (() => void) | undefined;
const UPDATED_AT = "2026-10-22T01:23:45Z";

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	setActiveAccountId("a");
	writes = [];
	holdRefetch = false;
	failWrite = false;
	releaseRefetch = undefined;
	let savedRepos = repos.map((r) => ({ ...r }));
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), "https://giraffe.test");
		if (init?.method === "POST") {
			const body = JSON.parse(String(init.body)) as { account_id: string; enabled: boolean };
			expect(url.pathname).toMatch(/^\/api\/repos\/owner\/[^/]+\/star$/);
			writes.push({ resource: url.pathname, body });
			if (failWrite)
				return Response.json({ error: { code: "db_error", message: "failed" } }, { status: 500 });
			savedRepos = savedRepos.map((r) =>
				url.pathname === `/api/repos/${r.name_with_owner}/star`
					? { ...r, starred: body.enabled, star_source: "owner", star_updated_at: UPDATED_AT }
					: r,
			);
			return Response.json({
				account_id: "a",
				name_with_owner: url.pathname.slice("/api/repos/".length, -"/star".length),
				starred: body.enabled,
				star_source: "owner",
				star_updated_at: UPDATED_AT,
			});
		}
		if (url.pathname === "/api/accounts")
			return Response.json({ accounts: [{ id: "a", login: "owner", is_active: true }] });
		if (url.pathname === "/api/repos") {
			if (holdRefetch && writes.length)
				await new Promise<void>((resolve) => {
					releaseRefetch = resolve;
				});
			return Response.json({
				account_id: "a",
				fetched_at: "2026-10-22T00:00:00Z",
				truncated: false,
				repos:
					url.searchParams.get("scope") === "all"
						? savedRepos
						: savedRepos.filter((r) => r.starred),
			});
		}
		if (url.pathname === "/api/insights") return Response.json({ account_id: "a", insights: [] });
		throw new Error(`Unexpected request: ${String(input)}`);
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	releaseRefetch?.();
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

it("shows accessible owner and agent markers but no marker for an absent record", async () => {
	await renderRepos("all");
	for (const grid of [false, true]) {
		if (grid) {
			const toggle = [...container.querySelectorAll("button")].find(
				(b) => b.textContent === "网格",
			);
			await act(async () => toggle?.click());
		}
		const markers = [...container.querySelectorAll('[role="note"]')];
		expect(markers.map((marker) => marker.getAttribute("aria-label"))).toEqual([
			"owner/archived 星标来源：owner",
			"owner/fork 星标来源：agent",
		]);
		expect(markers.map((marker) => marker.textContent)).toEqual(["手动", "Agent"]);
		const weekly = container.querySelector('[aria-label="星标 owner/weekly"]');
		expect(weekly?.parentElement?.querySelector('[role="note"]')).toBeNull();
	}
});

it("applies owner provenance from a toggle response before refetch and keeps its unstarred marker", async () => {
	await renderRepos("all");
	holdRefetch = true;
	const star = container.querySelector<HTMLButtonElement>('[aria-label="星标 owner/fork"]');
	await act(async () => star?.click());
	expect(star?.getAttribute("aria-pressed")).toBe("false");
	const marker = star?.parentElement?.querySelector('[role="note"]');
	expect(marker?.getAttribute("aria-label")).toBe("owner/fork 星标来源：owner");
	expect(marker?.textContent).toBe("手动");
	await act(async () => star?.focus());
	const tooltip = document.querySelector('[role="tooltip"]');
	expect(tooltip?.textContent).toContain("星标来源：手动");
	expect(tooltip?.querySelector("time")?.dateTime).toBe(UPDATED_AT);
	expect(container.querySelectorAll('[aria-label^="星标 owner/"]')).toHaveLength(3);
});

it("shows owner provenance immediately when starring a repository with no prior record", async () => {
	await renderRepos("all");
	holdRefetch = true;
	const star = container.querySelector<HTMLButtonElement>('[aria-label="星标 owner/weekly"]');
	await act(async () => star?.click());
	expect(star?.getAttribute("aria-pressed")).toBe("true");
	expect(star?.parentElement?.querySelector('[role="note"]')?.getAttribute("aria-label")).toBe(
		"owner/weekly 星标来源：owner",
	);
});

it("retains the saved star and agent provenance after a failed owner write", async () => {
	await renderRepos("all");
	failWrite = true;
	const star = container.querySelector<HTMLButtonElement>('[aria-label="星标 owner/fork"]');
	await act(async () => star?.click());
	expect(star?.getAttribute("aria-pressed")).toBe("true");
	expect(star?.parentElement?.querySelector('[role="note"]')?.getAttribute("aria-label")).toBe(
		"owner/fork 星标来源：agent",
	);
});
