import { describe, expect, it } from "vitest";
import {
	aggregateFactory,
	emptyMetrics,
	factoryWindow,
	filterFactoryEvents,
	summarizeEvents,
} from "./factory";
import type { FactoryEvent, FactoryRepo } from "./factory-types";

const window = { since: "2026-06-18T00:00:00.000Z", until: "2026-09-16T00:00:00.000Z" };
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

describe("factory measurement contract", () => {
	it("uses 90 UTC calendar dates, including the partial current date", () => {
		expect(factoryWindow("2026-09-15T22:00:00Z")).toEqual({
			since: "2026-06-18T00:00:00.000Z",
			until: "2026-09-15T22:00:00.000Z",
		});
	});
	it("deduplicates by stable event id and uses merged cohort lead time, not closed PRs", () => {
		const merged = event({
			mergedAt: "2026-09-03T00:00:00Z",
			closedAt: "2026-09-03T00:00:00Z",
			state: "merged",
		});
		const m = summarizeEvents(
			"prs",
			[merged, merged, event({ id: "2", state: "closed", closedAt: "2026-09-04T00:00:00Z" })],
			window,
		);
		expect(m.prMerged).toBe(1);
		expect(m.prClosed).toBe(1);
		expect(m.cycleHours).toEqual([48]);
		expect(m.prOpened).toBe(2);
	});
	it("excludes the end boundary, counts commit time in UTC and never sums different event kinds as contributions", () => {
		const m = summarizeEvents(
			"commits",
			[event({ at: window.until }), event({ id: "2", at: "2026-09-10T02:00:00+08:00" })],
			window,
		);
		expect(m.commits).toBe(1);
		expect(m.days["2026-09-09"]?.commits).toBe(1);
	});
	it("uses decisive completed workflow runs for CI success, retaining other conclusions separately", () => {
		const m = summarizeEvents(
			"actions",
			[
				event({ conclusion: "success" }),
				event({ id: "2", conclusion: "failure" }),
				event({ id: "3", conclusion: "cancelled" }),
				event({ id: "4", conclusion: "skipped" }),
				event({ id: "5", conclusion: null }),
			],
			window,
		);
		expect(m.ciSuccess).toBe(1);
		expect(m.ciFailure).toBe(1);
		expect(m.ciOther).toBe(2);
		expect(m.ciPending).toBe(1);
	});
	it("counts current aged WIP separately from window inflow and recognizes only bot identities", () => {
		const m = summarizeEvents(
			"prs",
			[
				event({ createdAt: "2026-01-01T00:00:00Z", author: "dependabot[bot]" }),
				event({ id: "2", author: "human", title: "dependabot update" }),
			],
			window,
		);
		expect(m.prOpened).toBe(1);
		expect(m.agedPrs).toBe(2);
		expect(m.botOpen).toBe(1);
	});
	it("returns null for unobserved rates and aggregates raw denominators rather than repo averages", () => {
		const repos = [
			{ metrics: { ...emptyMetrics(), ciSuccess: 9, ciFailure: 1 } },
			{ metrics: { ...emptyMetrics(), ciSuccess: 0, ciFailure: 1 } },
		] as FactoryRepo[];
		expect(aggregateFactory(repos).ciRate).toBeCloseTo(9 / 11);
		expect(aggregateFactory([]).ciRate).toBeNull();
		expect(aggregateFactory([]).cycleP50).toBeNull();
	});
});

describe("factory flow and aging cohorts", () => {
	it("counts issue created/last-closed timestamps, excluding unknown and old closures", () => {
		const m = summarizeEvents(
			"issues",
			[
				event({ closedAt: "2026-09-12T00:00:00Z" }),
				event({ id: "2", state: "closed", closedAt: "2020-01-01", createdAt: "2020-01-01" }),
				event({ id: "3", createdAt: "bad" }),
			],
			window,
		);
		expect(m.issueOpened).toBe(1);
		expect(m.issueClosed).toBe(1);
		expect(m.agedIssues).toBe(1);
	});
	it("counts recognized dependency bots and valid lead times only", () => {
		const m = summarizeEvents(
			"prs",
			[
				event({ mergedAt: "2026-09-10T00:00:00Z", state: "merged", author: "renovate[bot]" }),
				event({
					id: "2",
					mergedAt: "2026-09-10T00:00:00Z",
					createdAt: "2026-09-11T00:00:00Z",
					state: "merged",
				}),
				event({ id: "3", createdAt: "2026-09-15T00:00:00Z" }),
			],
			window,
		);
		expect(m.botMerged).toBe(1);
		expect(m.agedPrs).toBe(0);
		expect(m.cycleHours).toHaveLength(1);
	});
	it("keeps published releases and open alerts separate from drafts and resolved alerts", () => {
		expect(
			summarizeEvents("releases", [event(), event({ id: "2", state: "draft" })], window).releases,
		).toBe(1);
		expect(
			summarizeEvents("alerts", [event(), event({ id: "2", state: "fixed" })], window).alerts,
		).toBe(1);
	});
	it("merges shared days/authors and handles multiple commit authors", () => {
		const a = summarizeEvents("commits", [event(), event({ id: "2" })], window);
		const b = summarizeEvents("commits", [event({ id: "3", author: "someone" })], window);
		const m = aggregateFactory([{ metrics: a }, { metrics: b }] as FactoryRepo[]);
		expect(m.days["2026-09-10"]?.commits).toBe(3);
		expect(m.authors.nocoo).toBe(2);
		expect(m.authors.someone).toBe(1);
	});
});

it("treats GitHub logins that match Object prototype names as ordinary authors", () => {
	const m = summarizeEvents(
		"commits",
		[event({ author: "constructor" }), event({ id: "2", author: "toString" })],
		window,
	);
	expect(m.authors.constructor).toBe(1);
	expect(m.authors.toString).toBe(1);
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
