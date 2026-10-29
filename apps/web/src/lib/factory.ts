import type { FactoryDay, FactoryEvent, FactoryMetrics, FactoryRepo } from "./factory-types";

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

/** Detail predicates run before pagination, so current WIP is not hidden on a later page. */
export function filterFactoryEvents(
	items: FactoryEvent[],
	state: string,
	day: string,
): FactoryEvent[] {
	const at = (e: FactoryEvent) =>
		state === "merged" ? e.mergedAt : state === "closed" ? e.closedAt : e.at;
	return items
		.filter((e) => {
			const time = at(e);
			return (
				(!state || e.state === state || e.conclusion === state) &&
				(!day ||
					(time !== null &&
						Number.isFinite(Date.parse(time)) &&
						new Date(time).toISOString().slice(0, 10) === day))
			);
		})
		.sort(
			(a, b) =>
				(Date.parse(at(b) ?? "") || 0) - (Date.parse(at(a) ?? "") || 0) || a.id.localeCompare(b.id),
		);
}
