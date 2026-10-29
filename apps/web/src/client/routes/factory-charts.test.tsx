// @vitest-environment happy-dom

import { TooltipProvider } from "@nocoo/basalt";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { FactoryHeatmap } from "./factory-charts";

it("places a UTC Sunday in row seven even when the local weekday is Saturday", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const localWeekday = vi.spyOn(Date.prototype, "getDay").mockReturnValue(6);
	const container = document.createElement("div");
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<TooltipProvider>
					<FactoryHeatmap
						days={[{ date: "2026-10-25", count: 1 }]}
						timezone="UTC"
						selected=""
						onSelect={() => undefined}
					/>
				</TooltipProvider>,
			),
		);
		expect(container.querySelector<HTMLButtonElement>(".factory-day")?.style.gridRow).toBe("7");
	} finally {
		await act(async () => root.unmount());
		localWeekday.mockRestore();
		vi.unstubAllGlobals();
	}
});
