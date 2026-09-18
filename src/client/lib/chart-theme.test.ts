import { expect, it } from "vitest";
import { chartColor } from "./chart-theme";

it("cycles five distinct brand-derived series and falls back safely", () => {
	const colors = Array.from({ length: 5 }, (_, index) => chartColor(index));
	expect(new Set(colors).size).toBe(5);
	expect(colors.every((color) => color.includes("--basalt-primary"))).toBe(true);
	expect(chartColor(5)).toBe(colors[0]);
	expect(chartColor(9)).toBe(colors[4]);
	expect(chartColor(-1)).toBe(colors[0]);
	expect(chartColor(Number.NaN)).toBe(colors[0]);
});
