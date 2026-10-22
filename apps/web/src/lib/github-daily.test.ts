import { expect, it } from "vitest";
import { analysisTimeCases } from "../../../../tests/fixtures/analysis-times";
import { dailyPayload, dailyResource } from "./__tests__/github-daily-fixture";
import {
	compareGeneratedAt,
	decodeGithubDaily,
	decodeGithubDailyResource,
	githubDailySchema,
} from "./github-daily";

it("R8 accepts strict daily payloads, reporting dates independent of generation day, and preserves escaped text", () => {
	const value = dailyPayload("2024-02-29", "2026-10-22T08:00:00+08:00");
	expect(githubDailySchema.parse(value)).toEqual(value);
	expect(decodeGithubDaily(value)).toEqual(value);
	expect(decodeGithubDailyResource(dailyResource())).toEqual(dailyResource());
	const raw = dailyResource();
	expect(decodeGithubDailyResource({ ...raw, payload: JSON.stringify(raw.payload) })).toEqual(raw);
});

it.each([
	{ date: "2026-02-29" },
	{ date: "2026-10-2" },
	{ generatedAt: "2026-10-22" },
	{ generatedAt: "2026-10-22T00:00:00" },
	{ generatedAt: `2026-10-22T00:00:00.${"1".repeat(110)}Z` },
	{ headline: " " },
	{ headline: "x".repeat(301) },
	{ refreshRunId: "bad/id" },
	{ window: { since: "2026-10-22T00:00:00.0002Z", until: "2026-10-22T00:00:00.0001Z" } },
	{ window: { since: "2026-10-22T00:00:00Z", until: "2026-10-22T00:00:00Z", extra: true } },
	{ sections: Array.from({ length: 13 }, () => ({ title: "x", markdown: "", items: [] })) },
	{ sections: [{ title: "x", markdown: "x".repeat(12001), items: [] }] },
	{
		sections: [
			{
				title: "x",
				markdown: "",
				items: Array.from({ length: 51 }, () => dailyPayload().sections[0]?.items[0]),
			},
		],
	},
	{ comparisons: { vsYesterday: "x".repeat(4001), vs7d: "" } },
	{ links: { xray: "javascript:alert(1)" } },
	{ links: { xray: "http://x.example" } },
	{ links: { xray: "not a URL" } },
	{ links: { xray: "https://user:password@x.example" } },
	{
		sources: [{ resource: "x", version: null, fetchedAt: "invalid", complete: true, stale: false }],
	},
	{
		sources: [
			{ resource: "x", version: null, fetchedAt: null, complete: true, stale: false, extra: true },
		],
	},
	{
		sources: Array.from({ length: 501 }, () => ({
			resource: "x",
			version: null,
			fetchedAt: null,
			complete: true,
			stale: false,
		})),
	},
	{ sections: [{ title: "x".repeat(201), markdown: "", items: [] }] },
	{
		sections: [
			{
				title: "x",
				markdown: "",
				items: [{ repo: "bad-repo", kind: "x", url: "https://x.example", severity: "x" }],
			},
		],
	},
	{
		sections: [
			{
				title: "x",
				markdown: "",
				items: [{ repo: null, kind: " ", url: "https://x.example", severity: "x" }],
			},
		],
	},
	{
		sections: [
			{
				title: "x",
				markdown: "",
				items: [{ repo: null, kind: "x", url: "https://x.example", severity: " " }],
			},
		],
	},
	{ scope: "global" },
	{ unknown: true },
	{ sections: null },
])("R8 rejects invalid daily structure or caps %j", (patch) => {
	expect(githubDailySchema.safeParse({ ...dailyPayload(), ...patch }).success).toBe(false);
});

it("R8 daily source/link/item caps and precise empty window rules stay strict", () => {
	for (const [field, invalid] of [
		["resource", "x".repeat(241)],
		["version", "x".repeat(201)],
		["contentVersion", "invalid"],
		["complete", "true"],
	] as const) {
		const value = dailyPayload();
		value.sources = [{ ...value.sources[0], [field]: invalid }] as typeof value.sources;
		expect(decodeGithubDaily(value)).toBeNull();
	}
	const value = dailyPayload();
	value.links.xray = `https://x.example/${"x".repeat(2048)}`;
	expect(decodeGithubDaily(value)).toBeNull();
	value.links.xray = "https://x.example";
	value.window = {
		since: "2026-10-22T08:00:00.00000000000000000001+08:00",
		until: "2026-10-22T00:00:00.00000000000000000001Z",
	};
	expect(decodeGithubDaily(value)).toEqual(value);
});

it("R8 accepts fifty link items, nullable global repo and empty quiet-day arrays", () => {
	const value = dailyPayload();
	const item = {
		repo: null,
		kind: "global",
		url: "https://any-host.example/path",
		severity: "custom",
	};
	value.sections = [
		{ title: "Links", markdown: "", items: Array.from({ length: 50 }, () => item) },
	];
	expect(decodeGithubDaily(value)).toEqual(value);
	value.sections = [];
	value.sources = [];
	expect(decodeGithubDaily(value)).toEqual(value);
});

it("R8 validates the original UTF-8 JSON at exactly 65536/65537 bytes", () => {
	const value = dailyPayload();
	value.sections = Array.from({ length: 6 }, () => ({
		title: "x",
		markdown: "界".repeat(3000),
		items: [],
	}));
	let remaining = 65536 - new TextEncoder().encode(JSON.stringify(value)).length;
	for (const section of value.sections) {
		const added = Math.min(remaining, 12000 - section.markdown.length);
		section.markdown += "x".repeat(added);
		remaining -= added;
	}
	expect(remaining).toBe(0);
	expect(new TextEncoder().encode(JSON.stringify(value))).toHaveLength(65536);
	expect(decodeGithubDaily(value)).toEqual(value);
	value.headline += "x";
	expect(decodeGithubDaily(value)).toBeNull();
});

it("R8 raw special keys are rejected instead of silently transformed or discarded", () => {
	for (const target of ["root", "window", "links", "section", "item", "source", "comparisons"]) {
		for (const length of [1, 66000]) {
			const value = dailyPayload();
			const object =
				target === "root"
					? value
					: target === "section"
						? value.sections[0]
						: target === "item"
							? value.sections[0]?.items[0]
							: target === "source"
								? value.sources[0]
								: value[target as "window" | "links" | "comparisons"];
			Object.defineProperty(object, "__proto__", {
				value: { hidden: "x".repeat(length) },
				enumerable: true,
			});
			expect(decodeGithubDaily(JSON.parse(JSON.stringify(value)))).toBeNull();
		}
	}
	expect(decodeGithubDaily(null)).toBeNull();
	expect(decodeGithubDailyResource(null)).toBeNull();
	expect(decodeGithubDailyResource({ ...dailyResource(), payload: "{" })).toBeNull();
	for (const patch of [
		{ id: "legacy" },
		{ type: "other" },
		{ repository: "owner/app" },
		{ status: "pending" },
		{ revision: 0 },
		{ updated_at: "invalid" },
	])
		expect(decodeGithubDailyResource({ ...dailyResource(), ...patch })).toBeNull();
});

it.each(analysisTimeCases)("R8 exact comparator preserves $name", ({ entries, expected }) => {
	const sorted = [...entries].sort(
		([leftId, leftTime], [rightId, rightTime]) =>
			compareGeneratedAt(rightTime, leftTime) || (leftId < rightId ? 1 : leftId > rightId ? -1 : 0),
	);
	expect(sorted.slice(0, 3).map(([id]) => id)).toEqual(expected);
});
