// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { emptyMetrics, factoryWindow } from "../../lib/factory";
import type { FactoryViewSnapshot } from "../../lib/factory-types";
import { loadFactory, loadFactoryDetail } from "../viewmodels/factory";
import { FactoryPage } from "./factory";

vi.mock("../viewmodels/factory", async (original) => ({
	...(await original<typeof import("../viewmodels/factory")>()),
	loadFactory: vi.fn(),
	loadFactoryDetail: vi.fn(),
}));
vi.mock("@nocoo/basalt/components/section-rule", () => ({
	SectionRule: ({ title, children }: { title: ReactNode; children?: ReactNode }) => (
		<section>
			<h2>{title}</h2>
			{children}
		</section>
	),
}));
vi.mock("../components/layout/data-time", () => ({
	DataTimeSource: () => null,
}));
vi.mock("../components/layout/project-identity", () => ({
	ProjectLabel: ({ repo }: { repo: string }) => <span>{repo}</span>,
}));
vi.mock("./factory-charts", () => ({
	FactoryPanel: ({ title, children }: { title: string; children: ReactNode }) => (
		<section data-panel={title}>{children}</section>
	),
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

function snapshotWithSignals(): FactoryViewSnapshot {
	const raw = factoryFixture();
	raw.window = factoryWindow(raw.fetched_at, 90);
	const base = raw.repos[0];
	if (!base) throw new Error("fixture");
	const repos = Array.from({ length: 8 }, (_, i) => ({
		...base,
		id: `R_${i}`,
		name: `nocoo/r${i}`,
		coverage: structuredClone(base.coverage),
		metrics: { ...emptyMetrics(), agedPrs: i === 0 ? 2 : 1, alerts: i === 0 ? 1 : 0 },
	}));
	return { ...raw, repos, selectedRepos: repos };
}

async function renderFactory() {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	const container = document.createElement("div");
	const root = createRoot(container);
	await act(async () =>
		root.render(
			<MemoryRouter initialEntries={["/factory"]}>
				<FactoryPage />
			</MemoryRouter>,
		),
	);
	return { container, root };
}

it("groups inspection signals per repository, expands on demand and pages the groups", async () => {
	vi.mocked(loadFactory).mockResolvedValue(snapshotWithSignals());
	vi.mocked(loadFactoryDetail).mockReset().mockResolvedValue(null);
	const { container, root } = await renderFactory();
	try {
		const rows = () => Array.from(container.querySelectorAll<HTMLElement>("[data-signal-group]"));
		expect(rows()).toHaveLength(6);
		const first = rows()[0];
		expect(first?.textContent).toContain("nocoo/r0");
		expect(first?.textContent).toContain("2 条");
		expect(container.textContent).not.toContain("2 个 open PR ≥7 天");

		await act(async () => first?.querySelector("button")?.click());
		expect(container.textContent).toContain("2 个 open PR ≥7 天");

		expect(container.textContent).toContain("第 1/2 页");
		const next = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "后 6 个项目",
		);
		await act(async () => next?.click());
		expect(container.textContent).toContain("第 2/2 页");
		expect(rows()[0]?.textContent).toContain("nocoo/r6");
	} finally {
		await act(async () => root.unmount());
	}
});
