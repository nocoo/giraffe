// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { factoryWindow } from "../../lib/factory";
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
		children,
	}: {
		id?: string;
		title: ReactNode;
		hint?: ReactNode;
		children?: ReactNode;
	}) => (
		<section>
			<h2 id={id}>{title}</h2>
			<p>{hint}</p>
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
	FactoryPanel: ({ children }: { children: ReactNode }) => <section>{children}</section>,
	FactorySpark: () => null,
	FactoryHeatmap: () => null,
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

it.each([30, 90])("labels the published %i-day chart window", async (dayCount) => {
	const raw = factoryFixture();
	raw.window = factoryWindow(raw.fetched_at, dayCount);
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
		expect(container.textContent).toContain("每日快速刷新 30 天，每周深度刷新校准 90 天");
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

it.each(["?repo=nocoo%2Fmissing", "?language=Swift"])(
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
