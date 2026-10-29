// @vitest-environment happy-dom
import { TooltipProvider } from "@nocoo/basalt";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { emptyDay } from "../../lib/factory";
import type { RefreshRun } from "../../lib/refresh-types";
import { RefreshProvider } from "../components/layout/refresh-provider";
import { apiGet } from "../lib/api";
import { ApiError } from "../lib/errors";
import { loadFactory } from "../viewmodels/factory";
import { defaultRefreshParams } from "../viewmodels/refresh";
import { loadRepoTab, type RepoDetails } from "../viewmodels/repo-detail";
import { setActiveAccountId } from "../viewmodels/session";
import { RepoDetailPage } from "./repo-detail";

vi.mock("../lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock("../lib/local-environment", () => ({ isRemoteReadOnly: () => false }));
vi.mock("../viewmodels/repo-detail", async (original) => ({
	...(await original<typeof import("../viewmodels/repo-detail")>()),
	loadRepoTab: vi.fn(),
}));
vi.mock("../viewmodels/factory", async (original) => ({
	...(await original<typeof import("../viewmodels/factory")>()),
	loadFactory: vi.fn(),
}));
vi.mock("../components/layout/use-project-identity", () => ({ useProjectIdentity: () => null }));
vi.mock("../components/layout/project-identity", () => ({
	ProjectName: ({ repo }: { repo: string }) => <span>{repo}</span>,
	ProjectLinks: () => null,
}));
vi.mock("../components/repo-agent-state", () => ({ RepoAgentStateCard: () => null }));
vi.mock("../components/repo-meta", () => ({ RepoMetaCard: () => null }));
vi.mock("./repo-factory", () => ({ RepoFactoryTab: () => <div>Factory records loaded</div> }));
vi.mock("./repo-charts", () => ({
	RepoActivityChart: ({ days }: { days: { commits: number }[] }) => (
		<span>Calendar commits: {days.reduce((total, day) => total + day.commits, 0)}</span>
	),
	ReleaseTimeline: () => null,
	RunOutcomeChart: () => null,
}));

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.resetAllMocks();
});

it("retains valid repository details when terminal revalidation fails transiently", async () => {
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	setActiveAccountId("account-1");
	const snapshot = factoryFixture();
	vi.mocked(loadFactory).mockResolvedValue({ ...snapshot, selectedRepos: snapshot.repos });
	const details: RepoDetails = {
		account_id: "account-1",
		fetched_at: snapshot.fetched_at,
		truncated: false,
		description: "Saved repository",
		homepage: null,
		default_branch: "main",
		license: null,
		is_archived: false,
		open_issue_count: 1,
		stargazer_count: 0,
		fork_count: 0,
		pushed_at: snapshot.fetched_at,
		url: "https://github.com/nocoo/app",
	};
	vi.mocked(loadRepoTab)
		.mockResolvedValueOnce(details)
		.mockRejectedValueOnce(new ApiError(503, "db_error", "unavailable"));
	const run: RefreshRun = {
		id: "transient-run",
		accountId: "account-1",
		params: defaultRefreshParams(),
		trigger: "manual",
		status: "running",
		phase: "repos",
		repos: ["nocoo/app"],
		completedRepos: 0,
		requests: 1,
		requestBreakdown: {
			total: 1,
			graphql: 1,
			rest: 0,
			a: { graphql: 1, rest: 0 },
			b: { graphql: 0, rest: 0 },
		},
		partialReasons: [],
		cancelRequested: false,
		partial: false,
		errorCode: null,
		createdAt: snapshot.fetched_at,
		updatedAt: snapshot.fetched_at,
		finishedAt: null,
	};
	vi.mocked(apiGet).mockResolvedValueOnce({ items: [run], collectionAvailable: true });
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<RefreshProvider>
					<MemoryRouter initialEntries={["/repos/nocoo/app?tab=factory"]}>
						<Routes>
							<Route path="/repos/:owner/:name" element={<RepoDetailPage />} />
						</Routes>
					</MemoryRouter>
				</RefreshProvider>,
			),
		);
		expect(container.querySelector('[role="tablist"]')).not.toBeNull();
		vi.mocked(apiGet).mockResolvedValueOnce({ ...run, status: "completed", phase: "done" });
		await act(async () => vi.advanceTimersByTimeAsync(3000));
		expect(loadRepoTab).toHaveBeenCalledTimes(2);
		expect(container.querySelector('[role="tablist"]')).not.toBeNull();
		expect(container.textContent).toContain("Factory records loaded");
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});

it.each(["details", "factory", "actions", "releases"])(
	"does not let an older initial %s response overwrite terminal revalidation",
	async (resource) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-29T04:00:00Z"));
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		setActiveAccountId("account-1");
		const snapshot = factoryFixture();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		repo.metrics.days = { "2026-09-14": { ...emptyDay(), commits: 2 } };
		const latestFactory = { ...snapshot, selectedRepos: snapshot.repos };
		const oldFactory = structuredClone(latestFactory);
		if (!oldFactory.repos[0]) throw new Error("fixture");
		oldFactory.repos[0].metrics.days = { "2026-09-14": { ...emptyDay(), commits: 99 } };
		const saved = { account_id: "account-1", fetched_at: snapshot.fetched_at, truncated: false };
		const details: RepoDetails = {
			...saved,
			description: "Saved repository",
			homepage: null,
			default_branch: "main",
			license: null,
			is_archived: false,
			open_issue_count: 0,
			stargazer_count: 0,
			fork_count: 0,
			pushed_at: snapshot.fetched_at,
			url: "https://github.com/nocoo/app",
		};
		const actions = {
			...saved,
			runs: [
				{
					id: 1,
					name: "Latest workflow",
					html_url: "https://github.com/nocoo/app/actions/runs/1",
					status: "completed",
					conclusion: "success",
					event: "push",
					head_branch: "main",
					created_at: snapshot.fetched_at,
					updated_at: snapshot.fetched_at,
				},
			],
		};
		const releases = {
			...saved,
			releases: [
				{
					id: 1,
					name: "Latest release",
					tag_name: "latest-release",
					html_url: "https://github.com/nocoo/app/releases/tag/v1",
					draft: false,
					prerelease: false,
					published_at: snapshot.fetched_at,
				},
			],
		};
		let finish: ((body: unknown) => void) | undefined;
		let held = false;
		const oldRead = () =>
			new Promise<never>((resolve) => {
				finish = resolve as (body: unknown) => void;
			});
		vi.mocked(loadFactory).mockImplementation(async () => {
			if (resource === "factory" && !held) {
				held = true;
				return oldRead();
			}
			return latestFactory;
		});
		vi.mocked(loadRepoTab).mockImplementation(async (_owner, _name, tab) => {
			if (resource === tab && !held) {
				held = true;
				return oldRead();
			}
			return (({ details, actions, releases } as Record<string, unknown>)[tab] ?? {
				missing: true,
			}) as never;
		});
		const run: RefreshRun = {
			id: "race-run",
			accountId: "account-1",
			params: defaultRefreshParams(),
			trigger: "manual",
			status: "running",
			phase: "repos",
			repos: ["nocoo/app"],
			completedRepos: 0,
			requests: 1,
			requestBreakdown: {
				total: 1,
				graphql: 1,
				rest: 0,
				a: { graphql: 1, rest: 0 },
				b: { graphql: 0, rest: 0 },
			},
			partialReasons: [],
			cancelRequested: false,
			partial: false,
			errorCode: null,
			createdAt: snapshot.fetched_at,
			updatedAt: snapshot.fetched_at,
			finishedAt: null,
		};
		vi.mocked(apiGet).mockResolvedValueOnce({ items: [run], collectionAvailable: true });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const tab = resource === "details" ? "factory" : resource === "factory" ? "details" : resource;
		try {
			await act(async () =>
				root.render(
					<TooltipProvider>
						<RefreshProvider>
							<MemoryRouter initialEntries={[`/repos/nocoo/app?tab=${tab}`]}>
								<Routes>
									<Route path="/repos/:owner/:name" element={<RepoDetailPage />} />
								</Routes>
							</MemoryRouter>
						</RefreshProvider>
					</TooltipProvider>,
				),
			);
			expect(finish).toBeDefined();
			vi.mocked(apiGet).mockResolvedValueOnce({ ...run, status: "completed", phase: "done" });
			await act(async () => vi.advanceTimersByTimeAsync(3000));
			await act(async () =>
				finish?.(
					resource === "details"
						? { missing: true }
						: resource === "factory"
							? oldFactory
							: resource === "actions"
								? { ...actions, runs: [{ ...actions.runs[0], name: "Old workflow" }] }
								: { ...releases, releases: [{ ...releases.releases[0], tag_name: "old-release" }] },
				),
			);
			const expected = {
				details: "Factory records loaded",
				factory: "Calendar commits: 2",
				actions: "Latest workflow",
				releases: "latest-release",
			};
			expect(container.textContent).toContain(expected[resource as keyof typeof expected]);
			expect(container.textContent).not.toContain("Calendar commits: 99");
			expect(container.textContent).not.toContain("Old workflow");
			expect(container.textContent).not.toContain("Old release");
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	},
);

it.each(["factory", "details"])(
	"restores missing details on %s without combining retained timezones",
	async (tab) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-29T04:00:00Z"));
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		setActiveAccountId("account-1");
		const run: RefreshRun = {
			id: "repo-refresh",
			accountId: "account-1",
			params: { ...defaultRefreshParams(), repo: "nocoo/app" },
			trigger: "manual",
			status: "running",
			phase: "repos",
			repos: ["nocoo/app"],
			completedRepos: 0,
			requests: 1,
			requestBreakdown: {
				total: 1,
				graphql: 1,
				rest: 0,
				a: { graphql: 1, rest: 0 },
				b: { graphql: 0, rest: 0 },
			},
			partialReasons: [],
			cancelRequested: false,
			partial: false,
			errorCode: null,
			createdAt: "2026-10-29T04:00:00Z",
			updatedAt: "2026-10-29T04:00:00Z",
			finishedAt: null,
		};
		vi.mocked(apiGet).mockResolvedValueOnce({ items: [run], collectionAvailable: true });
		const snapshot = factoryFixture();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		snapshot.window = {
			since: "2026-10-27T16:00:00Z",
			until: "2026-10-28T15:59:59.999Z",
			timezone: "Asia/Shanghai",
		};
		repo.metrics.days = { "2026-10-28": { ...emptyDay(), commits: 4, issueOpened: 2 } };
		repo.coverage.commits.completeWindows = [
			{
				since: "2026-10-28T04:00:00Z",
				until: "2026-10-29T03:59:59.999Z",
				timezone: "America/New_York",
			},
		];
		vi.mocked(loadFactory).mockResolvedValue({ ...snapshot, selectedRepos: snapshot.repos });
		const details: RepoDetails = {
			account_id: "account-1",
			fetched_at: "2026-10-29T04:00:00Z",
			truncated: false,
			description: "Saved repository",
			homepage: null,
			default_branch: "main",
			license: null,
			is_archived: false,
			open_issue_count: 0,
			stargazer_count: 0,
			fork_count: 0,
			pushed_at: "2026-10-28T04:00:00Z",
			url: "https://github.com/nocoo/app",
		};
		let detailsReads = 0;
		vi.mocked(loadRepoTab).mockImplementation(async (_owner, _name, resource) => {
			if (resource !== "details") return { missing: true };
			detailsReads++;
			return detailsReads === 1 ? { missing: true } : details;
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<RefreshProvider>
						<MemoryRouter initialEntries={[`/repos/nocoo/app?tab=${tab}`]}>
							<Routes>
								<Route path="/repos/:owner/:name" element={<RepoDetailPage />} />
							</Routes>
						</MemoryRouter>
					</RefreshProvider>,
				),
			);
			expect(container.querySelector('[role="tablist"]')).toBeNull();
			expect(detailsReads).toBe(1);
			vi.mocked(apiGet).mockResolvedValueOnce({
				...run,
				status: "completed",
				phase: "done",
				completedRepos: 1,
				finishedAt: "2026-10-29T04:00:03Z",
			});
			await act(async () => vi.advanceTimersByTimeAsync(3000));
			expect(apiGet).toHaveBeenCalledWith("refresh-runs/repo-refresh");
			expect(detailsReads).toBe(2);
			expect(loadRepoTab).toHaveBeenCalledWith("nocoo", "app", "details");
			expect(container.querySelector('[role="tablist"]')).not.toBeNull();
			if (tab === "factory") expect(container.textContent).toContain("Factory records loaded");
			else {
				expect(container.textContent).toContain("来源时区不一致或日期不可用");
				expect(container.textContent).not.toContain("Calendar commits:");
				expect(container.textContent).not.toContain("30 天 新开 0");
			}
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	},
);
