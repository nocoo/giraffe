import { describe, expect, it } from "vitest";
import {
	ageBuckets,
	countBy,
	dailySeries,
	daysAgo,
	matchesFilters,
	shortRepo,
	weeklySeries,
} from "./overview";

const NOW = "2026-09-18T12:00:00Z";

describe("overview aggregation", () => {
	it("measures age in whole UTC days from the snapshot clock", () => {
		expect(daysAgo("2026-09-18T01:00:00Z", NOW)).toBe(0);
		expect(daysAgo("2026-09-17T23:00:00Z", NOW)).toBe(1);
		expect(daysAgo("2026-08-19T00:00:00Z", NOW)).toBe(30);
		expect(daysAgo(null, NOW)).toBeNull();
		expect(daysAgo("not a date", NOW)).toBeNull();
		expect(daysAgo("2026-09-20T00:00:00Z", NOW)).toBe(0);
	});

	it("buckets ages and keeps unknown dates out of every bucket", () => {
		const buckets = ageBuckets(
			[
				"2026-09-18T00:00:00Z",
				"2026-09-12T00:00:00Z",
				"2026-08-01T00:00:00Z",
				"2020-01-01T00:00:00Z",
				null,
			],
			NOW,
		);
		expect(buckets.rows.map((b) => [b.key, b.count])).toEqual([
			["d1", 1],
			["d7", 1],
			["d30", 0],
			["d90", 1],
			["old", 1],
		]);
		expect(buckets.unknown).toBe(1);
		expect(buckets.max).toBe(1);
		expect(ageBuckets([], NOW).max).toBe(1);
	});

	it("ranks categories, folds the tail into 其他 and reports shares", () => {
		const rows = ["a", "b", "a", "c", "a", "b", "d", ""].map((k) => ({ k }));
		const ranked = countBy(rows, (r) => r.k, 2);
		expect(ranked.rows).toEqual([
			{ name: "a", value: 3, share: 3 / 8 },
			{ name: "b", value: 2, share: 2 / 8 },
			{ name: "其他", value: 3, share: 3 / 8, other: 3 },
		]);
		expect(ranked.total).toBe(8);
		expect(ranked.max).toBe(3);
		expect(countBy(rows, (r) => r.k).rows).toHaveLength(5);
		expect(countBy([], (r: { k: string }) => r.k)).toEqual({ rows: [], total: 0, max: 1 });
	});

	it("builds a daily series ending on the snapshot day, split by a category", () => {
		const rows = [
			{ at: "2026-09-18T01:00:00Z", r: "author" },
			{ at: "2026-09-18T02:00:00Z", r: "comment" },
			{ at: "2026-09-16T02:00:00Z", r: "author" },
			{ at: "2026-07-01T00:00:00Z", r: "author" },
			{ at: "bad", r: "author" },
		];
		const series = dailySeries(
			rows,
			(x) => x.at,
			NOW,
			3,
			(x) => x.r,
		);
		expect(series.keys).toEqual(["author", "comment"]);
		expect(series.points).toEqual([
			{ x: "2026-09-16", total: 1, author: 1, comment: 0 },
			{ x: "2026-09-17", total: 0, author: 0, comment: 0 },
			{ x: "2026-09-18", total: 2, author: 1, comment: 1 },
		]);
		expect(series.outside).toBe(2);
		expect(dailySeries(rows, (x) => x.at, NOW, 2).points.at(-1)).toEqual({
			x: "2026-09-18",
			total: 2,
		});
	});

	it("builds Monday-based weekly counts ending with the snapshot week", () => {
		const rows = [
			"2026-09-14T00:00:00Z",
			"2026-09-18T00:00:00Z",
			"2026-09-07T10:00:00Z",
			"2026-01-01T00:00:00Z",
		];
		expect(weeklySeries(rows, (x) => x, NOW, 3)).toEqual([
			{ x: "08-31", y: 0 },
			{ x: "09-07", y: 1 },
			{ x: "09-14", y: 2 },
		]);
		expect(weeklySeries([], (x) => x, "bad", 3)).toEqual([]);
	});

	it("applies independent equality filters and ignores empty ones", () => {
		const row = { repo: "a/b", label: "bug" };
		const get = { repo: (r: typeof row) => r.repo, label: (r: typeof row) => r.label };
		expect(matchesFilters(row, get, { repo: "a/b", label: "" })).toBe(true);
		expect(matchesFilters(row, get, { repo: "a/b", label: "docs" })).toBe(false);
		expect(matchesFilters(row, { tags: () => ["x", "y"] }, { tags: "y" })).toBe(true);
		expect(matchesFilters(row, { tags: () => ["x"] }, { tags: "y" })).toBe(false);
		expect(shortRepo("nocoo/giraffe")).toBe("giraffe");
		expect(shortRepo("plain")).toBe("plain");
	});
});
