import { getChartColor } from "@nocoo/basalt/charts/config";
import { chart } from "@nocoo/basalt/charts/palette";

const YELLOW = "var(--color-giraffe-yellow)";

export function chartColor(index: number): string {
	const color = getChartColor(index);
	return color === chart.amber ? YELLOW : color;
}

const CATEGORIES: Record<string, string> = {
	typescript: chart.primary,
	javascript: YELLOW,
	python: YELLOW,
	go: chart.green,
	rust: chart.rose,
	swift: YELLOW,
	kotlin: chart.rose,
	java: chart.rose,
	ruby: chart.rose,
	php: chart.primary,
	"c#": chart.green,
	"c++": chart.rose,
	c: chart.gray,
	shell: chart.green,
	html: YELLOW,
	css: chart.rose,
	vue: chart.green,
	dart: chart.green,
	objectivec: chart.primary,
	未标记: chart.gray,
	"": chart.gray,
};

export function categoryColor(name: string): string {
	const key = name.trim().toLowerCase();
	const fixed = Object.hasOwn(CATEGORIES, key) ? CATEGORIES[key] : undefined;
	if (fixed) return fixed;
	let hash = 0;
	for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return chartColor(hash);
}

export const FLOW_COLORS = {
	commits: chart.primary,
	merged: chart.green,
	opened: YELLOW,
	closed: chart.green,
	release: chart.rose,
	stock: YELLOW,
	rate: chart.rose,
} as const;
