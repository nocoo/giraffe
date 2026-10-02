// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RefreshTimes } from "../../../lib/refresh-times";
import { setActiveAccountId } from "../../viewmodels/session";
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
	setActiveAccountId("a");
	const times: RefreshTimes = {
		account_id: "a",
		runs: [{ startedAt: "2026-10-02T08:00:00Z", finishedAt: "2026-10-02T08:10:00Z" }],
	};
	vi.mocked(fetchKind).mockResolvedValue(times);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	setActiveAccountId(null);
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
function Page({ at = "2026-10-02T08:00:00Z", visible = true }: { at?: string; visible?: boolean }) {
	return (
		<DataTimeProvider>
			<DataTimeControl />
			{visible ? <DataTimeSource entries={[{ label: "Issues", at }]} /> : null}
		</DataTimeProvider>
	);
}
it("registers sources, ticks relative age, replaces data and cleans up on navigation", async () => {
	await act(async () => root.render(<Page />));
	expect(container.textContent).toContain("2 小时前更新");
	expect(fetchKind).toHaveBeenCalledWith("refresh/times");
	await act(async () => vi.advanceTimersByTimeAsync(3600000));
	expect(container.textContent).toContain("3 小时前更新");
	await act(async () => root.render(<Page at="2026-09-30T08:00:00Z" />));
	expect(container.textContent).toContain("2 天前更新");
	await act(async () => root.render(<Page visible={false} />));
	expect(container.textContent).toContain("暂无数据时间");
});
it("does not replace saved times with another account's refresh completion", async () => {
	const times: RefreshTimes = {
		account_id: "other",
		runs: [{ startedAt: "2026-10-01T00:00:00Z", finishedAt: "2026-10-02T10:00:00Z" }],
	};
	vi.mocked(fetchKind).mockResolvedValue(times);
	await act(async () => root.render(<Page />));
	expect(container.textContent).toContain("2 小时前更新");
});
it("keeps data age when refresh records cannot be read", async () => {
	vi.mocked(fetchKind).mockRejectedValue(new Error("offline"));
	await act(async () => root.render(<Page />));
	expect(container.textContent).toContain("2 小时前更新");
	vi.mocked(fetchKind).mockResolvedValue({ missing: true });
	await act(async () => window.dispatchEvent(new Event("focus")));
	expect(container.textContent).toContain("2 小时前更新");
});

it("opens one named popover with precise times and mixed/missing source notices", async () => {
	await act(async () =>
		root.render(
			<DataTimeProvider>
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
	expect(dialog?.querySelector("time")?.dateTime).toBe("2026-10-02T08:10:00Z");
	await act(async () =>
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
	);
	expect(document.querySelector('[role="dialog"]')).toBeNull();
});
