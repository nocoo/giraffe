// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSnapshotRead } from "./use-snapshot-read";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	container = document.createElement("div");
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function Reader({
	load,
	failed,
	enabled = true,
	initialRead = true,
}: {
	load: () => Promise<number>;
	failed: (error: unknown) => void;
	enabled?: boolean;
	initialRead?: boolean;
}) {
	const [data, setData] = useState(0);
	const [filter, setFilter] = useState("initial");
	useSnapshotRead(load, setData, failed, enabled, initialRead);
	return (
		<button type="button" onClick={() => setFilter("kept")}>
			{filter}:{data}
		</button>
	);
}

describe("visible snapshot revalidation", () => {
	it("can preserve an existing initial loader without duplicate first requests", async () => {
		const load = vi.fn().mockResolvedValue(2);
		await act(async () => root.render(<Reader load={load} failed={vi.fn()} initialRead={false} />));
		expect(load).not.toHaveBeenCalled();
		await act(async () => window.dispatchEvent(new Event("focus")));
		expect(load).toHaveBeenCalledTimes(1);
	});
	it("discards a late read when mutations pause background updates", async () => {
		let finish: ((value: number) => void) | undefined;
		const load = vi.fn(
			() =>
				new Promise<number>((resolve) => {
					finish = resolve;
				}),
		);
		const failed = vi.fn();
		await act(async () => root.render(<Reader load={load} failed={failed} />));
		await act(async () => root.render(<Reader load={load} failed={failed} enabled={false} />));
		await act(async () => finish?.(99));
		expect(container.textContent).toBe("initial:0");
		expect(failed).not.toHaveBeenCalled();
	});
	it("polls and rereads on focus without remounting or clearing filters", async () => {
		const load = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(2);
		const failed = vi.fn();
		await act(async () => root.render(<Reader load={load} failed={failed} />));
		expect(load).toHaveBeenCalledTimes(1);
		await act(async () => container.querySelector("button")?.click());
		await act(async () => vi.advanceTimersByTimeAsync(60_000));
		expect(container.textContent).toBe("kept:2");
		expect(load).toHaveBeenCalledTimes(2);
		await act(async () => window.dispatchEvent(new Event("focus")));
		expect(load).toHaveBeenCalledTimes(3);
		expect(failed).not.toHaveBeenCalled();
	});

	it("skips hidden tabs, resumes on visibility and does not overlap reads", async () => {
		let finish: ((value: number) => void) | undefined;
		const load = vi.fn(
			() =>
				new Promise<number>((resolve) => {
					finish = resolve;
				}),
		);
		const visibility = vi.spyOn(document, "visibilityState", "get");
		visibility.mockReturnValue("hidden");
		await act(async () => root.render(<Reader load={load} failed={vi.fn()} />));
		await act(async () => vi.advanceTimersByTimeAsync(60_000));
		expect(load).not.toHaveBeenCalled();
		visibility.mockReturnValue("visible");
		await act(async () => document.dispatchEvent(new Event("visibilitychange")));
		await act(async () => window.dispatchEvent(new Event("focus")));
		await act(async () => vi.advanceTimersByTimeAsync(60_000));
		expect(load).toHaveBeenCalledTimes(1);
		await act(async () => finish?.(3));
		expect(container.textContent).toBe("initial:3");
	});

	it("pauses during mutations and ignores late results and failures after cleanup", async () => {
		let fail: ((error: unknown) => void) | undefined;
		const load = vi.fn(
			() =>
				new Promise<number>((_resolve, reject) => {
					fail = reject;
				}),
		);
		const failed = vi.fn();
		await act(async () => root.render(<Reader load={load} failed={failed} enabled={false} />));
		expect(load).not.toHaveBeenCalled();
		await act(async () => root.render(<Reader load={load} failed={failed} />));
		await act(async () => root.render(<Reader load={load} failed={failed} enabled={false} />));
		await act(async () => fail?.(new Error("late")));
		expect(failed).not.toHaveBeenCalled();
		await act(async () => window.dispatchEvent(new Event("focus")));
		expect(load).toHaveBeenCalledTimes(1);
		load.mockImplementation(async () => {
			throw new Error("current");
		});
		await act(async () => root.render(<Reader load={load} failed={failed} />));
		expect(failed).toHaveBeenCalledWith(new Error("current"));
	});
});
