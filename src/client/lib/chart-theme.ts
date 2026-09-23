// Fixed category palette: Basalt 2.1 aliases many named chart colors to the same five hues.
const chart = {
	cobalt: "#3b82f6",
	amber: "#d99a16",
	teal: "#14b8a6",
	orange: "#f97316",
	purple: "#a855f7",
	green: "#22a55b",
	rose: "#f43f5e",
	sky: "#0ea5e9",
	indigo: "#6366f1",
	gold: "#b9a228",
	vermilion: "#d65f3b",
	red: "#ef4444",
	crimson: "#be3455",
	steel: "#64748b",
	lime: "#84a520",
	tangerine: "#e87835",
	orchid: "#c65dc5",
	jade: "#159c80",
	seafoam: "#40aab0",
	gray: "#8b8f99",
};
const COLORS = [
	chart.cobalt,
	chart.amber,
	chart.teal,
	chart.orange,
	chart.purple,
	chart.green,
	chart.rose,
	chart.sky,
	chart.indigo,
	chart.gold,
];
const CATEGORIES: Record<string, string> = {
	typescript: chart.cobalt,
	javascript: chart.amber,
	python: chart.sky,
	go: chart.teal,
	rust: chart.vermilion,
	swift: chart.orange,
	kotlin: chart.purple,
	java: chart.red,
	ruby: chart.crimson,
	php: chart.indigo,
	"c#": chart.green,
	"c++": chart.rose,
	c: chart.steel,
	shell: chart.lime,
	html: chart.tangerine,
	css: chart.orchid,
	vue: chart.jade,
	dart: chart.seafoam,
	objectivec: chart.sky,
	未标记: chart.gray,
	"": chart.gray,
};

export function chartColor(index: number): string {
	return COLORS[index % COLORS.length] ?? chart.cobalt;
}

export function categoryColor(name: string): string {
	const key = name.trim().toLowerCase();
	const fixed = Object.hasOwn(CATEGORIES, key) ? CATEGORIES[key] : undefined;
	if (fixed) return fixed;
	let hash = 0;
	for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return chartColor(hash);
}

/** Validated in both themes (lightness, CVD and contrast) for the factory's composed charts. */
export const FLOW_COLORS = {
	commits: "#3b82f6",
	merged: "#0d9488",
	opened: "#d97706",
	closed: "#0d9488",
	release: "#8b5cf6",
	stock: "#d97706",
	rate: "#8b5cf6",
} as const;
