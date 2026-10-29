// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { factoryFixture, savedFactoryWindow } from "../../../../../tests/fixtures/factory-snapshot";
import type { FactoryViewSnapshot } from "../../lib/factory-types";
import { loadFactory, loadFactoryDetail } from "../viewmodels/factory";
import { FactoryPage } from "./factory";

vi.mock("../viewmodels/factory", async (original) => ({
	...(await original<typeof import("../viewmodels/factory")>()),
	loadFactory: vi.fn(),
	loadFactoryDetail: vi.fn(),
}));
vi.mock("@nocoo/basalt/components/section-rule", () => ({
	SectionRule: ({
		id,
		title,
		hint,
		actions,
		children,
	}: {
		id?: string;
		title: ReactNode;
		hint?: ReactNode;
		actions?: ReactNode;
		children?: ReactNode;
	}) => (
		<section>
			<h2 id={id}>{title}</h2>
			<p>{hint}</p>
			{actions}
			{children}
		</section>
	),
}));
vi.mock("../components/layout/data-time", () => ({
	DataTimeSource: ({
		entries,
	}: {
		entries: { freshness?: { total: number; missing: number } }[];
	}) => <span data-freshness={JSON.stringify(entries[0]?.freshness)} />,
}));
vi.mock("../components/layout/project-identity", () => ({
	ProjectLabel: ({ repo }: { repo: string }) => <span>{repo}</span>,
}));
vi.mock("./factory-charts", () => ({
	FactoryPanel: ({ title, children }: { title: ReactNode; children: ReactNode }) => (
		<section>
			<h2>{title}</h2>
			{children}
		</section>
	),
	FactorySpark: () => null,
	FactoryHeatmap: ({
		days,
		timezone,
		onSelect,
	}: {
		days: { date: string }[];
		timezone: string;
		onSelect: (date: string) => void;
	}) => (
		<button
			type="button"
			data-calendar-days={days.length}
			data-calendar-timezone={timezone}
			onClick={() => onSelect(days[0]?.date ?? "")}
		/>
	),
	FactoryTreemap: () => null,
}));
vi.mock("./factory-story", () => ({
	ActivityQuadrant: () => null,
	BacklogPanel: () => null,
	CommitBreadthChart: () => null,
	DeliveryChart: () => null,
	FlowStockChart: () => null,
	PeriodStrip: () => null,
	RepoPeriodMatrix: () => null,
}));

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it.each(["observed", "catalogue-only", "account-only"])(
	"shows the account contribution year with %s data",
	async (state) => {
		const raw = factoryFixture();
		raw.contribution = {
			days: Array.from({ length: 365 }, (_, index) => ({
				date: new Date(Date.parse("2025-10-29T00:00:00Z") + index * 86_400_000)
					.toISOString()
					.slice(0, 10),
				count: 1,
			})),
			total: 365,
			restricted: 0,
			fetchedAt: raw.fetched_at,
		};
		vi.mocked(loadFactory).mockResolvedValue({
			...raw,
			repos: state === "observed" ? raw.repos : [],
			selectedRepos: state === "account-only" ? [] : raw.repos,
		});
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<MemoryRouter>
						<FactoryPage />
					</MemoryRouter>,
				),
			);
			expect(container.querySelector('[data-calendar-days="365"]')).not.toBeNull();
			expect(
				container.querySelector("[data-calendar-timezone]")?.getAttribute("data-calendar-timezone"),
			).toBe("UTC");
			expect(container.textContent).toContain("账号贡献日历");
			expect(container.textContent).not.toContain("账号贡献无法按仓库范围筛选，已停止展示");
		} finally {
			await act(async () => root.unmount());
		}
	},
);

it("clears a selected contribution date when the same scope loses its calendar", async () => {
	const raw = factoryFixture();
	raw.contribution = {
		days: [{ date: "2025-10-29", count: 3 }],
		total: 3,
		restricted: 0,
		fetchedAt: raw.fetched_at,
	};
	vi.mocked(loadFactory).mockResolvedValue({ ...raw, selectedRepos: raw.repos });
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	const container = document.createElement("div");
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<MemoryRouter>
					<FactoryPage />
				</MemoryRouter>,
			),
		);
		await act(async () =>
			container.querySelector<HTMLButtonElement>("[data-calendar-days]")?.click(),
		);
		expect(container.textContent).toContain("3 账号贡献");
		vi.mocked(loadFactory).mockResolvedValue({
			...raw,
			contribution: null,
			contributionStatus: "unavailable",
			selectedRepos: raw.repos,
		});
		await act(async () => {
			window.dispatchEvent(new Event("focus"));
		});
		expect(container.textContent).toContain("当前显示仓库提交");
		expect(container.textContent).not.toContain("已高亮每日账本");
		expect(container.querySelector(".factory-ledger-selected")).toBeNull();
	} finally {
		await act(async () => root.unmount());
	}
});

it.each([0, 2])(
	"keeps partially observed commit dates selectable without inventing a zero: %i",
	async (commits) => {
		const raw = factoryFixture();
		raw.window = {
			since: "2026-09-10T00:00:00Z",
			until: "2026-09-10T23:59:59.999Z",
			timezone: "UTC",
		};
		const repo = raw.repos[0];
		if (!repo) throw new Error("fixture");
		repo.coverage.commits.status = "limited";
		repo.coverage.commits.observed = 1;
		repo.coverage.commits.fetchedAt = raw.fetched_at;
		repo.metrics.days = { "2026-09-10": { ...repo.metrics, commits } };
		vi.mocked(loadFactory).mockResolvedValue({
			...raw,
			contribution: null,
			selectedRepos: raw.repos,
		});
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<MemoryRouter>
						<FactoryPage />
					</MemoryRouter>,
				),
			);
			expect(container.querySelector("[data-calendar-days]")).not.toBeNull();
			await act(async () =>
				container.querySelector<HTMLButtonElement>("[data-calendar-days]")?.click(),
			);
			expect(container.textContent).toContain(`${commits ? "≥ 2" : "—"} 提交；已高亮每日账本`);
			expect(container.querySelector(".factory-ledger-selected")).not.toBeNull();
		} finally {
			await act(async () => root.unmount());
		}
	},
);

it.each([false, true])(
	"labels source calendar days and withholds mixed timezones: %s",
	async (mixed) => {
		const raw = factoryFixture();
		raw.window = {
			since: "2026-10-27T16:00:00Z",
			until: "2026-10-28T15:59:59.999Z",
			timezone: "Asia/Shanghai",
		};
		const repo = raw.repos[0];
		if (!repo) throw new Error("fixture");
		repo.metrics.days = { "2026-10-28": { ...repo.metrics, commits: 2 } };
		if (mixed)
			repo.coverage.commits.completeWindows = [
				{
					since: "2026-03-08T05:00:00Z",
					until: "2026-03-09T03:59:59.999Z",
					timezone: "America/New_York",
				},
			];
		vi.mocked(loadFactory).mockResolvedValue({ ...raw, selectedRepos: raw.repos });
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<MemoryRouter>
						<FactoryPage />
					</MemoryRouter>,
				),
			);
			if (mixed) {
				expect(container.textContent).toContain(
					"来源时区不一致，日历与期间汇总不可合并；缺失不代表零。",
				);
				expect(container.querySelector("#factory-change-title")).toBeNull();
			} else {
				expect(container.textContent).toContain("1 个 Asia/Shanghai 日期");
				expect(container.textContent).toContain(
					"2026-10-28 00:00 → 2026-10-29 00:00 (Asia/Shanghai)",
				);
				expect(container.textContent).not.toContain("08:00 →");
			}
		} finally {
			await act(async () => root.unmount());
		}
	},
);

it("defaults the historical chart window to 90 days and keeps range options", async () => {
	const raw = factoryFixture();
	raw.window = savedFactoryWindow(raw.fetched_at, 90);
	vi.mocked(loadFactory).mockResolvedValue({ ...raw, selectedRepos: raw.repos });
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.createElement("div");
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<MemoryRouter initialEntries={["/factory"]}>
					<FactoryPage />
				</MemoryRouter>,
			),
		);
		expect(container.querySelector("#factory-change-title")?.textContent).toBe("变化 · 最近 90 天");
		const radios = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
		expect(radios.map((radio) => radio.textContent)).toEqual(
			expect.arrayContaining(["30 天", "90 天", "180 天", "365 天"]),
		);
		const thirty = radios.find((radio) => radio.textContent === "30 天");
		if (!thirty) throw new Error("Missing 30-day chart range");
		await act(async () => thirty.click());
		expect(container.querySelector("#factory-change-title")?.textContent).toBe("变化 · 最近 30 天");
		expect(container.textContent).toContain("没有观测的日期保持空白，不按零绘制");
		const wider = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
			(radio) => radio.textContent === "180 天",
		);
		if (!wider) throw new Error("Missing 180-day chart range");
		await act(async () => wider.click());
		expect(container.querySelector("#factory-change-title")?.textContent).toBe(
			"变化 · 最近 180 天",
		);
		expect(container.textContent).toContain("已发布覆盖 90 天，更早日期为空白");
		const [ninety] = Array.from(
			container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
		).filter((radio) => radio.textContent === "90 天");
		if (!ninety) throw new Error("Missing 90-day chart range");
		await act(async () => ninety.click());
		expect(container.querySelector("#factory-change-title")?.textContent).toBe("变化 · 最近 90 天");
		expect(container.textContent).not.toContain("已发布覆盖");
	} finally {
		await act(async () => root.unmount());
	}
});

it.each([30, 90])("labels the published %i-day chart window", async (dayCount) => {
	const raw = factoryFixture();
	raw.window = savedFactoryWindow(raw.fetched_at, dayCount);
	vi.mocked(loadFactory).mockResolvedValue({ ...raw, selectedRepos: raw.repos });
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	const container = document.createElement("div");
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<MemoryRouter initialEntries={["/factory"]}>
					<FactoryPage />
				</MemoryRouter>,
			),
		);
		expect(container.querySelector("#factory-change-title")?.textContent).toBe(
			`变化 · 最近 ${dayCount} 天`,
		);
		expect(container.textContent).not.toContain("每日快速刷新");
		expect(container.textContent).not.toContain("每周深度刷新");
		expect(container.textContent).toContain("默认 7 天仅用于期间比较");
		const methodology = Array.from(container.querySelectorAll("details")).find(
			(details) => details.querySelector("summary")?.textContent === "来源、口径与不确定性",
		);
		if (!methodology) throw new Error("Missing factory methodology");
		methodology.open = true;
		expect(methodology.textContent).toContain("历史总量与观测窗口内流量分开");
		expect(methodology.textContent).not.toMatch(/历史总量与\s*90\s*天流量分开/);
	} finally {
		await act(async () => root.unmount());
	}
});

it.each(["unavailable", "complete"] as const)(
	"keeps dependency graph missingness distinct from a measured zero: %s",
	async (status) => {
		const raw = factoryFixture();
		for (const repo of raw.repos) {
			repo.dependencies = [];
			repo.coverage.dependencies.status = status;
		}
		vi.mocked(loadFactory).mockResolvedValue({ ...raw, selectedRepos: raw.repos });
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<MemoryRouter>
						<FactoryPage />
					</MemoryRouter>,
				),
			);
			const panel = Array.from(container.querySelectorAll("h2")).find(
				(heading) => heading.textContent === "依赖与维护",
			)?.parentElement;
			expect(panel?.textContent).toContain(status === "complete" ? "观测引用边 0" : "观测引用边 —");
			expect(panel?.textContent?.includes("依赖分析缺少完整观测，缺失不代表没有依赖。")).toBe(
				status !== "complete",
			);
		} finally {
			await act(async () => root.unmount());
		}
	},
);

it("keeps the dashboard shell and missing values without retired refresh messages", async () => {
	vi.mocked(loadFactory).mockResolvedValue({ missing: true });
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	const container = document.createElement("div");
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<MemoryRouter initialEntries={["/factory"]}>
					<FactoryPage />
				</MemoryRouter>,
			),
		);
		expect(container.textContent).toContain("软件工厂");
		expect(container.textContent).toContain("暂无已保存的快照");
		expect(container.textContent).toContain("统一刷新");
		expect(container.textContent).not.toContain("旧刷新已停用");
		const headings = Array.from(container.querySelectorAll("h2")).map(
			(heading) => heading.textContent,
		);
		for (const title of [
			"变化 · 暂无观测窗口",
			"提交产出与覆盖面",
			"交付吞吐",
			"PR 流量与存量",
			"Issue 流量与存量",
			"仓库变化矩阵",
			"存量 · 我名下全部仓库",
			"提交日历",
			"积压任务",
			"仓库规模地图",
			"提交与待办",
			"工作流量账",
			"需要检查的信号",
			"依赖与维护",
			"仓库生产线 · 按窗口提交量排序",
		])
			expect(headings).toContain(title);
		expect(container.querySelectorAll(".giraffe-stat-card")).toHaveLength(5);
		expect(container.querySelectorAll(".factory-period dd")).toHaveLength(5);
		for (const value of container.querySelectorAll(".factory-period dd"))
			expect(value.textContent).toBe("—");
		expect(container.querySelector('table[aria-label="仓库生产线"]')).not.toBeNull();
		expect(container.querySelectorAll("time")).toHaveLength(0);
		expect(container.textContent).not.toMatch(/最近 \d+ 天|\d{4}-\d{2}-\d{2}|0 个|0%/);
		expect(container.textContent).not.toContain("刷新暂不可用");
		expect(container.querySelector('a[href^="/refresh"]')).toBeNull();
		expect(container.textContent).not.toContain("离开页面后也会继续");
	} finally {
		await act(async () => root.unmount());
	}
});

it.each(["?q=unpublished", "?language=Swift"])(
	"shows selected unpublished data as missing, not an empty filter: %s",
	async (query) => {
		const raw = factoryFixture();
		const snapshot: FactoryViewSnapshot = {
			...raw,
			selectedRepos: [
				{ name: "nocoo/app", description: "Example", language: "TypeScript", topics: ["cli"] },
				{ name: "nocoo/missing", description: "Unpublished", language: "Swift", topics: null },
			],
		};
		vi.mocked(loadFactory).mockResolvedValue(snapshot);
		vi.mocked(loadFactoryDetail).mockReset().mockResolvedValue(null);
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<MemoryRouter initialEntries={[`/factory${query}`]}>
						<FactoryPage />
					</MemoryRouter>,
				),
			);
			expect(container.textContent).toContain("所选 1 个仓库尚无工厂观测");
			expect(container.textContent).not.toContain("没有符合当前筛选的仓库");
			expect(
				JSON.parse(
					container.querySelector("[data-freshness]")?.getAttribute("data-freshness") ?? "{}",
				),
			).toMatchObject({ total: 1, missing: 1, latestAt: null });
			expect(loadFactoryDetail).not.toHaveBeenCalled();
		} finally {
			await act(async () => root.unmount());
		}
	},
);
