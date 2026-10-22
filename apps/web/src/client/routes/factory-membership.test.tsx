// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import type { FactoryViewSnapshot } from "../../lib/factory-types";
import { loadFactory, loadFactoryDetail } from "../viewmodels/factory";
import { FactoryPage } from "./factory";

vi.mock("../viewmodels/factory", async (original) => ({
	...(await original<typeof import("../viewmodels/factory")>()),
	loadFactory: vi.fn(),
	loadFactoryDetail: vi.fn(),
}));
vi.mock("../components/layout/data-time", () => ({
	DataTimeSource: ({
		entries,
	}: {
		entries: { freshness?: { total: number; missing: number } }[];
	}) => <span data-freshness={JSON.stringify(entries[0]?.freshness)} />,
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
