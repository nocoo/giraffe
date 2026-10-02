import { expect, it } from "vitest";
import { dataTimeSummary } from "./data-time";

const start = "2026-10-02T08:00:00Z";
const end = "2026-10-02T08:10:00Z";
const now = Date.parse("2026-10-02T10:10:00Z");
const runs = [{ startedAt: start, finishedAt: end }];
it("uses the end of one refresh instead of individual collection times", () => {
	const result = dataTimeSummary(
		[
			{ label: "Issues", at: start },
			{ label: "PR", at: "2026-10-02T08:05:00Z" },
		],
		runs,
		now,
	);
	expect(result.latestAt).toBe(end);
	expect(result.label).toBe("2 小时前更新");
	expect(result.mixed).toBe(false);
	expect(result.rows.map((row) => row.at)).toEqual([end, end]);
});
it("keeps older and missing sources visible without making them fresh", () => {
	const result = dataTimeSummary(
		[
			{
				label: "Issues",
				at: end,
				freshness: { oldestAt: start, latestAt: end, total: 3, missing: 1 },
			},
			{ label: "PR", at: "2026-09-30T08:00:00Z" },
			{ label: "AI", at: null },
		],
		runs,
		now,
	);
	expect(result.label).toBe("2 小时前更新");
	expect(result.mixed).toBe(true);
	expect(result.incomplete).toBe(true);
	expect(result.rows[0]?.missing).toBe(1);
});
it("honors scoped freshness and distinguishes empty, missing, invalid and future data", () => {
	expect(dataTimeSummary([], [], now).label).toBe("暂无数据时间");
	expect(
		dataTimeSummary(
			[
				{
					label: "x",
					at: end,
					freshness: { oldestAt: null, latestAt: null, total: 0, missing: 0 },
				},
			],
			[],
			now,
		).label,
	).toBe("当前范围暂无数据");
	for (const at of [null, undefined, "invalid"]) {
		expect(dataTimeSummary([{ label: "x", at }], [], now).label).toBe("尚未更新");
	}
	expect(dataTimeSummary([{ label: "x", at: end }], [], Date.parse(end) + 1000).label).toBe(
		"刚刚更新",
	);
	expect(dataTimeSummary([{ label: "x", at: end }], [], Date.parse(end) - 1000).label).toBe(
		"时间晚于本机",
	);
	expect(dataTimeSummary([{ label: "x", at: start }], [], now + 86400000).label).toBe("1 天前更新");
	expect(
		dataTimeSummary(
			[
				{
					label: "x",
					at: end,
					freshness: { oldestAt: start, latestAt: end, total: 2, missing: 0 },
				},
			],
			[],
			now,
		).mixed,
	).toBe(true);
});
