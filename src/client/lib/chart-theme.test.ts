import { CHART_COLORS } from "@nocoo/basalt/charts/palette";
import { expect, it } from "vitest";
import { categoryColor, chartColor } from "./chart-theme";

it("uses the Basalt candy cycle with stable named categories and safe fallback", () => {
	const colors = Array.from({ length: 10 }, (_, index) => chartColor(index));
	expect(colors).toEqual([...CHART_COLORS, ...CHART_COLORS]);
	expect(chartColor(10)).toBe(colors[0]);
	expect(chartColor(-1)).toBe(colors[0]);
	expect(chartColor(Number.NaN)).toBe(colors[0]);
	expect(categoryColor(" TypeScript ")).toBe(categoryColor("typescript"));
	expect(categoryColor("TypeScript")).not.toBe(categoryColor("JavaScript"));
	expect(categoryColor("new-language")).toBe(categoryColor("NEW-LANGUAGE"));
	expect(categoryColor("未标记")).toBe(categoryColor(""));
});
