import { getChartColor } from "@nocoo/basalt/charts/config";
import { chart } from "@nocoo/basalt/charts/palette";

export { getChartColor as chartColor } from "@nocoo/basalt/charts/config";

const CATEGORIES: Record<string, string> = {
	typescript: chart.primary,
	javascript: chart.amber,
	python: chart.amber,
	go: chart.green,
	rust: chart.rose,
	swift: chart.amber,
	kotlin: chart.rose,
	java: chart.rose,
	ruby: chart.rose,
	php: chart.primary,
	"c#": chart.green,
	"c++": chart.rose,
	c: chart.gray,
	shell: chart.green,
	html: chart.amber,
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
	return getChartColor(hash);
}

export const FLOW_COLORS = {
	commits: chart.primary,
	merged: chart.green,
	opened: chart.amber,
	closed: chart.green,
	release: chart.rose,
	stock: chart.amber,
	rate: chart.rose,
} as const;
