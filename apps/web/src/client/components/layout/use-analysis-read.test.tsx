// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useAnalysisRead } from "./use-analysis-read";

it("pauses hidden polling, backs off failures, resumes focus and discards unmounted reads", async () => {
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	let visible = "visible";
	vi.spyOn(document, "visibilityState", "get").mockImplementation(
		() => visible as DocumentVisibilityState,
	);
	const load = vi.fn().mockResolvedValue(1),
		receive = vi.fn(),
		fail = vi.fn();
	const root = createRoot(document.createElement("div"));
	function Reader() {
		useAnalysisRead(load, receive, fail);
		return null;
	}
	try {
		await act(async () => root.render(<Reader />));
		expect(receive).toHaveBeenCalledWith(1);
		load.mockRejectedValue(new Error("offline"));
		await act(async () => vi.advanceTimersByTimeAsync(15000));
		expect(fail).toHaveBeenCalledTimes(1);
		await act(async () => vi.advanceTimersByTimeAsync(29000));
		expect(load).toHaveBeenCalledTimes(2);
		visible = "hidden";
		await act(async () => document.dispatchEvent(new Event("visibilitychange")));
		await act(async () => vi.advanceTimersByTimeAsync(60000));
		expect(load).toHaveBeenCalledTimes(2);
		visible = "visible";
		load.mockResolvedValue(2);
		await act(async () => window.dispatchEvent(new Event("focus")));
		expect(receive).toHaveBeenLastCalledWith(2);
	} finally {
		await act(async () => root.unmount());
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});
