// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchKind } from "../../viewmodels/snapshot";
import { DataTimeControl, DataTimeProvider, DataTimeSource } from "./data-time";

vi.mock("../../viewmodels/snapshot", () => ({ fetchKind: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-02T10:10:00Z"));
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	vi.mocked(fetchKind).mockClear();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
function Page({
	at = "2026-10-02T08:00:00Z",
	visible = true,
	scope = "issues:starred",
}: {
	at?: string;
	visible?: boolean;
	scope?: string;
}) {
	return (
		<DataTimeProvider scope={scope}>
			<header>Shared header</header>
			<DataTimeControl />
			{visible ? <DataTimeSource entries={[{ label: "Issues", at }]} /> : null}
		</DataTimeProvider>
	);
}
it("registers sources, ticks relative age, replaces data and cleans up on navigation", async () => {
	await act(async () => root.render(<Page />));
	expect(container.textContent).toContain("2 小时前更新");
	expect(fetchKind).not.toHaveBeenCalled();
	await act(async () => vi.advanceTimersByTimeAsync(3600000));
	expect(container.textContent).toContain("3 小时前更新");
	await act(async () => root.render(<Page at="2026-09-30T08:00:00Z" />));
	expect(container.textContent).toContain("2 天前更新");
	await act(async () => root.render(<Page visible={false} />));
	expect(container.textContent).toContain("暂无数据时间");
});
it("resets scoped sources without remounting children and re-registers unchanged entries", async () => {
	await act(async () => root.render(<Page />));
	const header = container.querySelector("header");
	expect(container.textContent).toContain("2 小时前更新");
	vi.mocked(fetchKind).mockClear();
	await act(async () => root.render(<Page scope="issues:all" />));
	expect(container.querySelector("header")).toBe(header);
	expect(container.textContent).toContain("2 小时前更新");
	expect(fetchKind).not.toHaveBeenCalled();
	await act(async () => root.render(<Page scope="repos:all" visible={false} />));
	expect(container.textContent).toContain("暂无数据时间");
	await act(async () => root.render(<Page scope="issues:starred" />));
	expect(container.textContent).toContain("2 小时前更新");
	await act(async () => root.render(<Page scope="issues:starred" visible={false} />));
	expect(container.textContent).toContain("暂无数据时间");
	expect(container.querySelector("header")).toBe(header);
});
it("keeps saved data age on focus without reading deleted refresh records", async () => {
	await act(async () => root.render(<Page />));
	expect(container.textContent).toContain("2 小时前更新");
	await act(async () => window.dispatchEvent(new Event("focus")));
	expect(container.textContent).toContain("2 小时前更新");
	expect(fetchKind).not.toHaveBeenCalled();
});

it("opens one named popover with precise times and mixed/missing source notices", async () => {
	await act(async () =>
		root.render(
			<DataTimeProvider scope="issues:starred">
				<DataTimeControl />
				<DataTimeSource
					entries={[
						{ label: "Issues", at: "2026-10-02T08:00:00Z" },
						{
							label: "PR",
							freshness: {
								oldestAt: "2026-09-29T08:00:00Z",
								latestAt: "2026-09-30T08:00:00Z",
								total: 2,
								missing: 1,
							},
						},
					]}
				/>
			</DataTimeProvider>,
		),
	);
	await act(async () => container.querySelector("button")?.click());
	const dialog = document.querySelector('[role="dialog"]');
	expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy();
	expect(dialog?.textContent).toContain("数据更新时间");
	expect(dialog?.textContent).toContain("部分数据仍来自较早的刷新");
	expect(dialog?.textContent).toContain("1 项缺少数据");
	expect(dialog?.querySelector("time")?.dateTime).toBe("2026-10-02T08:00:00Z");
	await act(async () =>
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
	);
	expect(document.querySelector('[role="dialog"]')).toBeNull();
});
