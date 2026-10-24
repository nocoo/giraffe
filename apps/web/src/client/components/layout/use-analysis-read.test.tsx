// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useAnalysisRead } from "./use-analysis-read";

function AnalysisReadProbe({
	load,
	receive,
	fail,
	intervalMs,
}: {
	load: () => Promise<number>;
	receive: (value: number) => void;
	fail: () => void;
	intervalMs?: number;
}) {
	useAnalysisRead(load, receive, fail, intervalMs);
	return null;
}

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
	try {
		await act(async () =>
			root.render(<AnalysisReadProbe load={load} receive={receive} fail={fail} />),
		);
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

it("supports a five-second repair poll without polling hidden pages", async () => {
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	const root = createRoot(document.createElement("div"));
	const load = vi.fn().mockResolvedValue(1);
	try {
		await act(async () =>
			root.render(
				<AnalysisReadProbe load={load} receive={() => {}} fail={() => {}} intervalMs={5000} />,
			),
		);
		await act(async () => vi.advanceTimersByTimeAsync(4999));
		expect(load).toHaveBeenCalledOnce();
		await act(async () => vi.advanceTimersByTimeAsync(1));
		expect(load).toHaveBeenCalledTimes(2);
	} finally {
		await act(async () => root.unmount());
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});
