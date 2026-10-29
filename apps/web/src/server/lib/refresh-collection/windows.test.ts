import { expect, it } from "vitest";
import { mergeWindows } from "./windows";

const day = (date: string) => ({
	since: `${date}T00:00:00.000Z`,
	until: `${date}T23:59:59.999Z`,
});
const at = (date: string) => day(date);

it("collapses contiguous days into one range", () => {
	expect(["2026-10-01", "2026-10-02", "2026-10-03"].map(at)).toStrictEqual([
		day("2026-10-01"),
		day("2026-10-02"),
		day("2026-10-03"),
	]);
	expect(mergeWindows(["2026-10-01", "2026-10-02", "2026-10-03"].map(at))).toEqual([
		{ since: "2026-10-01T00:00:00.000Z", until: "2026-10-03T23:59:59.999Z" },
	]);
});

it("never bridges missing days", () => {
	expect(mergeWindows(["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06"].map(at))).toEqual([
		{ since: "2026-10-01T00:00:00.000Z", until: "2026-10-02T23:59:59.999Z" },
		{ since: "2026-10-05T00:00:00.000Z", until: "2026-10-06T23:59:59.999Z" },
	]);
});

it("merges overlapping and nested windows without shortening coverage", () => {
	expect(
		mergeWindows([
			{ since: "2026-10-01T00:00:00.000Z", until: "2026-10-04T23:59:59.999Z" },
			at("2026-10-02"),
			{ since: "2026-10-03T00:00:00.000Z", until: "2026-10-05T23:59:59.999Z" },
		]),
	).toEqual([{ since: "2026-10-01T00:00:00.000Z", until: "2026-10-05T23:59:59.999Z" }]);
});

it("keeps single-day fragments when every other day is excluded", () => {
	const days = ["2026-10-01", "2026-10-03", "2026-10-05"].map(at);
	expect(mergeWindows(days)).toEqual(days);
});

it("sorts unordered windows before merging", () => {
	expect(mergeWindows([at("2026-10-03"), at("2026-10-01"), at("2026-10-02")])).toEqual([
		{ since: "2026-10-01T00:00:00.000Z", until: "2026-10-03T23:59:59.999Z" },
	]);
});

it("does not merge across timezones", () => {
	expect(
		mergeWindows([
			{ ...at("2026-10-01"), timezone: "Asia/Shanghai" },
			{ ...at("2026-10-02"), timezone: "UTC" },
			{ ...at("2026-10-03"), timezone: "UTC" },
		]),
	).toEqual([
		{
			since: "2026-10-01T00:00:00.000Z",
			until: "2026-10-01T23:59:59.999Z",
			timezone: "Asia/Shanghai",
		},
		{ since: "2026-10-02T00:00:00.000Z", until: "2026-10-03T23:59:59.999Z", timezone: "UTC" },
	]);
});

it("leaves the input untouched", () => {
	const windows = [at("2026-10-01"), at("2026-10-02")];
	const copy = structuredClone(windows);
	mergeWindows(windows);
	expect(windows).toEqual(copy);
	expect(mergeWindows([])).toEqual([]);
});
