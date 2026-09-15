import type {
	FactoryDay,
	FactoryEvent,
	FactoryMetrics,
	FactoryRepo,
	FactoryStreamName,
	FactoryWindow,
} from "./factory-types";

export function factoryWindow(now: string): FactoryWindow {
	const end = new Date(now);
	const start = new Date(now);
	start.setUTCHours(0, 0, 0, 0);
	start.setUTCDate(start.getUTCDate() - 89);
	return { since: start.toISOString(), until: end.toISOString() };
}
export function emptyDay(): FactoryDay {
	return {
		commits: 0,
		issueOpened: 0,
		issueClosed: 0,
		prOpened: 0,
		prMerged: 0,
		prClosed: 0,
		ciSuccess: 0,
		ciFailure: 0,
		releases: 0,
	};
}
export function emptyMetrics(): FactoryMetrics {
	return {
		...emptyDay(),
		ciOther: 0,
		ciPending: 0,
		agedPrs: 0,
		agedIssues: 0,
		botOpen: 0,
		botMerged: 0,
		alerts: 0,
		cycleHours: [],
		days: {},
		authors: Object.create(null) as Record<string, number>,
	};
}
export function inWindow(at: string | null, window: FactoryWindow): boolean {
	const t = Date.parse(at ?? "");
	return t >= Date.parse(window.since) && t < Date.parse(window.until);
}
export function uniqueEvents(items: FactoryEvent[]): FactoryEvent[] {
	return [...new Map(items.map((item) => [item.id, item])).values()];
}
export function summarizeEvents(
	stream: FactoryStreamName,
	events: FactoryEvent[],
	window: FactoryWindow,
): FactoryMetrics {
	const m = emptyMetrics();
	function count(key: keyof FactoryDay, at: string | null) {
		if (!inWindow(at, window) || at === null) return;
		const day = new Date(at).toISOString().slice(0, 10);
		const bucket = m.days[day] ?? emptyDay();
		bucket[key]++;
		m.days[day] = bucket;
		m[key]++;
	}
	for (const e of uniqueEvents(events)) {
		if (stream === "commits" && inWindow(e.at, window)) {
			count("commits", e.at);
			m.authors[e.author] = (m.authors[e.author] ?? 0) + 1;
		}
		if (stream === "issues") {
			count("issueOpened", e.createdAt);
			count("issueClosed", e.closedAt);
			if (e.state === "open" && Date.parse(window.until) - Date.parse(e.createdAt) >= 14 * 86400000)
				m.agedIssues++;
		}
		if (stream === "prs") {
			count("prOpened", e.createdAt);
			count("prMerged", e.mergedAt);
			if (!e.mergedAt) count("prClosed", e.closedAt);
			if (inWindow(e.mergedAt, window)) {
				const hours = (Date.parse(e.mergedAt ?? "") - Date.parse(e.createdAt)) / 3600000;
				if (Number.isFinite(hours) && hours >= 0) m.cycleHours.push(hours);
			}
			if (e.state === "open" && Date.parse(window.until) - Date.parse(e.createdAt) >= 7 * 86400000)
				m.agedPrs++;
			if (/^(dependabot|renovate)(\[bot\])?$/.test(e.author)) {
				if (e.state === "open") m.botOpen++;
				if (inWindow(e.mergedAt, window)) m.botMerged++;
			}
		}
		if (stream === "actions" && inWindow(e.createdAt, window)) {
			if (e.conclusion === "success") count("ciSuccess", e.createdAt);
			else if (
				["failure", "timed_out", "action_required", "startup_failure"].includes(e.conclusion ?? "")
			)
				count("ciFailure", e.createdAt);
			else if (e.conclusion == null) m.ciPending++;
			else m.ciOther++;
		}
		if (stream === "releases" && e.state !== "draft") count("releases", e.at);
		if (stream === "alerts" && e.state === "open") m.alerts++;
	}
	return m;
}
export function mergeMetrics(metrics: FactoryMetrics[]): FactoryMetrics {
	const m = emptyMetrics();
	for (const item of metrics) {
		for (const key of Object.keys(emptyDay()) as (keyof FactoryDay)[]) m[key] += item[key];
		for (const key of [
			"ciOther",
			"ciPending",
			"agedPrs",
			"agedIssues",
			"botOpen",
			"botMerged",
			"alerts",
		] as const)
			m[key] += item[key];
		m.cycleHours.push(...item.cycleHours);
		for (const [day, values] of Object.entries(item.days)) {
			const bucket = m.days[day] ?? emptyDay();
			for (const key of Object.keys(bucket) as (keyof FactoryDay)[]) bucket[key] += values[key];
			m.days[day] = bucket;
		}
		for (const [author, n] of Object.entries(item.authors))
			m.authors[author] = (m.authors[author] ?? 0) + n;
	}
	return m;
}
export function percentile(values: number[], p: number): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
}
export function aggregateFactory(repos: FactoryRepo[]) {
	const metrics = mergeMetrics(repos.map((r) => r.metrics));
	const decisive = metrics.ciSuccess + metrics.ciFailure;
	return {
		...metrics,
		ciRate: decisive ? metrics.ciSuccess / decisive : null,
		cycleP50: percentile(metrics.cycleHours, 0.5),
		cycleP90: percentile(metrics.cycleHours, 0.9),
	};
}
