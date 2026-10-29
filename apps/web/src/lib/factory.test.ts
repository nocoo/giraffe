import { expect, it } from "vitest";
import { aggregateFactory, emptyDay, emptyMetrics, filterFactoryEvents } from "./factory";
import type { FactoryEvent, FactoryMetrics, FactoryRepo } from "./factory-types";

const event = (overrides: Partial<FactoryEvent> = {}): FactoryEvent => ({
	id: "1",
	title: "Work",
	url: "https://github.com/nocoo/app/pull/1",
	at: "2026-09-10T00:00:00Z",
	createdAt: "2026-09-01T00:00:00Z",
	closedAt: null,
	mergedAt: null,
	author: "nocoo",
	state: "open",
	...overrides,
});

it("returns null for unobserved rates and aggregates saved raw denominators", () => {
	const repos = [
		{ metrics: { ...emptyMetrics(), ciSuccess: 9, ciFailure: 1 } },
		{ metrics: { ...emptyMetrics(), ciSuccess: 0, ciFailure: 1 } },
	] as FactoryRepo[];
	expect(aggregateFactory(repos).ciRate).toBeCloseTo(9 / 11);
	expect(aggregateFactory([]).ciRate).toBeNull();
	expect(aggregateFactory([]).cycleP50).toBeNull();
});

it("merges saved days and authors without recollecting events", () => {
	const first: FactoryMetrics = {
		...emptyMetrics(),
		commits: 2,
		days: { "2026-09-10": { ...emptyDay(), commits: 2 } },
		authors: { nocoo: 2 },
	};
	const second: FactoryMetrics = {
		...emptyMetrics(),
		commits: 1,
		days: { "2026-09-10": { ...emptyDay(), commits: 1 } },
		authors: { someone: 1, nocoo: 1 },
	};
	const merged = aggregateFactory([{ metrics: first }, { metrics: second }] as FactoryRepo[]);
	expect(merged.days["2026-09-10"]?.commits).toBe(3);
	expect(merged.authors.nocoo).toBe(3);
	expect(merged.authors.someone).toBe(1);
});

it("treats saved author keys matching Object prototype names as ordinary authors", () => {
	const metrics = {
		...emptyMetrics(),
		authors: JSON.parse('{"constructor":1,"toString":1}') as Record<string, number>,
	};
	const merged = aggregateFactory([{ metrics }] as FactoryRepo[]);
	expect(merged.authors.constructor).toBe(1);
	expect(merged.authors.toString).toBe(1);
});

it("reports reproducible nearest-rank percentiles for the merged cohort", () => {
	const result = aggregateFactory([
		{ metrics: { ...emptyMetrics(), cycleHours: [10, 2, 6, 4] } },
	] as FactoryRepo[]);
	expect(result.cycleP50).toBe(4);
	expect(result.cycleP90).toBe(10);
});

it("filters current WIP and UTC dates before detail pagination", () => {
	const rows = [
		event({ id: "old", at: "2026-09-01T00:00:00Z" }),
		event({ id: "new", at: "2026-09-03T02:00:00+08:00", conclusion: "failure" }),
		event({ id: "invalid", at: "bad", state: "closed" }),
	];
	expect(filterFactoryEvents(rows, "open", "").map((e) => e.id)).toEqual(["new", "old"]);
	expect(filterFactoryEvents(rows, "failure", "2026-09-02").map((e) => e.id)).toEqual(["new"]);
	expect(filterFactoryEvents(rows, "", "2026-09-01").map((e) => e.id)).toEqual(["old"]);
	expect(
		filterFactoryEvents([event({ id: "b" }), event({ id: "a" })], "", "").map((e) => e.id),
	).toEqual(["a", "b"]);
});

it("reconciles merged and closed daily drilldown against their actual lifecycle timestamps", () => {
	const items = [
		event({
			state: "merged",
			createdAt: "2026-07-01",
			at: "2026-07-01",
			mergedAt: "2026-09-03T02:00:00+08:00",
		}),
		event({ id: "2", state: "closed", closedAt: "2026-09-04T00:00:00Z" }),
		event({ id: "3", state: "closed", closedAt: null }),
	];
	expect(filterFactoryEvents(items, "merged", "2026-09-02").map((e) => e.id)).toEqual(["1"]);
	expect(filterFactoryEvents(items, "closed", "2026-09-04").map((e) => e.id)).toEqual(["2"]);
	expect(filterFactoryEvents(items, "closed", "")).toHaveLength(2);
});
