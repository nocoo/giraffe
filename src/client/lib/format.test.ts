// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
	candyClass,
	churnFilled,
	conclusionBadgeVariant,
	daysBetween,
	formatConclusion,
	formatCount,
	formatDate,
	formatDays,
	formatDelta,
	formatHealth,
	formatPreciseDate,
	formatReview,
	formatRunStatus,
	formatTimeAgo,
	formatVisibility,
	freshnessFilled,
	freshnessTone,
	healthBadgeVariant,
	initials,
	maxCount,
	meterFilled,
	opportunityBadgeVariant,
	opportunityLabel,
	reasonBadgeVariant,
	reviewBadgeVariant,
	severityBadgeVariant,
	sourceBadgeVariant,
	takeChips,
	visibilityBadgeVariant,
} from "./format";

describe("format", () => {
	it("formats local timestamps and second-accurate elapsed time without losing days", () => {
		const at = "2026-09-17T22:55:37.000Z";
		const base = Date.parse(at);
		expect(formatPreciseDate(at, "Asia/Shanghai")).toBe("2026年9月18日 06:55:37");
		expect(formatPreciseDate(at, "UTC")).toBe("2026年9月17日 22:55:37");
		expect(formatPreciseDate(at)).toMatch(/2026年9月\d+日 \d{2}:55:37/);
		for (const value of [null, undefined, "", "not-a-date"]) {
			expect(formatPreciseDate(value)).toBe("时间未知");
			expect(formatTimeAgo(value, base)).toBe("时间未知");
		}
		expect(formatTimeAgo(at, Number.NaN)).toBe("时间未知");
		expect(
			[0, 999, 1000, 59000, 60000, 3599000, 3600000, 86399000, 86400000, 90061000].map((ms) =>
				formatTimeAgo(at, base + ms),
			),
		).toEqual([
			"0 秒前",
			"0 秒前",
			"1 秒前",
			"59 秒前",
			"1 分 0 秒前",
			"59 分 59 秒前",
			"1 小时 0 分 0 秒前",
			"23 小时 59 分 59 秒前",
			"1 天 0 小时 0 分 0 秒前",
			"1 天 1 小时 1 分 1 秒前",
		]);
		expect(formatTimeAgo(at, base - 5000)).toBe("5 秒后（晚于本机时间）");
	});

	it("keeps snapshot ages compact while preserving unknown and future timestamps", () => {
		const at = "2026-09-17T22:55:37.000Z";
		const base = Date.parse(at);
		expect(formatTimeAgo(at, base + 90061000, true)).toBe("1 天前");
		expect(formatTimeAgo(at, base + 3661000, true)).toBe("1 小时前");
		expect(formatTimeAgo(at, base + 61000, true)).toBe("1 分前");
		expect(formatTimeAgo(at, base + 5000, true)).toBe("刚刚");
		expect(formatTimeAgo(at, base - 5000, true)).toBe("5 秒后（晚于本机时间）");
		expect(formatTimeAgo(null, base, true)).toBe("时间未知");
	});

	it("formats deltas, dates, counts, and labels", () => {
		expect(formatDelta(null, false)).toBe("—");
		expect(formatDelta(2, false)).toBe("+2");
		expect(formatDelta(-1200, false)).toBe("−1,200");
		expect(formatDelta(0, false)).toBe("0");
		expect(formatDelta(0, true)).toBe("—");
		expect(formatDate(null)).toBe("—");
		expect(formatDate(undefined)).toBe("—");
		expect(formatDate("not-a-date")).toBe("—");
		expect(formatDate("2024-03-15T12:00:00.000Z")).toMatch(/^2024-03-15 \d{2}:\d{2}$/);
		expect(formatCount(1200)).toBe("1,200");
		expect(formatDays(3)).toBe("3 天");
		expect(initials("")).toBe("?");
		expect(initials("  ")).toBe("?");
		expect(initials("dev")).toBe("DE");
		expect(initials("Zheng Li")).toBe("ZL");
		expect(formatHealth("strong")).toBe("健康");
		expect(formatHealth("watch")).toBe("观察");
		expect(formatHealth("risky")).toBe("风险");
		expect(healthBadgeVariant("strong")).toBe("green");
		expect(healthBadgeVariant("watch")).toBe("amber");
		expect(healthBadgeVariant("risky")).toBe("red");
		expect(formatVisibility("private")).toBe("私有");
		expect(formatVisibility("public")).toBe("公开");
		expect(formatVisibility("PUBLIC")).toBe("公开");
		expect(formatVisibility("internal")).toBe("internal");
		expect(severityBadgeVariant("critical")).toBe("red");
		expect(severityBadgeVariant("HIGH")).toBe("red");
		expect(severityBadgeVariant("medium")).toBe("orange");
		expect(severityBadgeVariant("low")).toBe("teal");
		expect(severityBadgeVariant("unknown")).toBe("gray");
		expect(formatReview(null)).toBe("—");
		expect(formatReview("APPROVED")).toBe("已批准");
		expect(formatReview("CHANGES_REQUESTED")).toBe("需修改");
		expect(formatReview("REVIEW_REQUIRED")).toBe("待审查");
		expect(formatReview("OTHER")).toBe("OTHER");
		expect(reviewBadgeVariant("APPROVED")).toBe("green");
		expect(reviewBadgeVariant("CHANGES_REQUESTED")).toBe("rose");
		expect(reviewBadgeVariant(null)).toBe("gray");
		expect(formatRunStatus("completed")).toBe("完成");
		expect(formatRunStatus("in_progress")).toBe("进行中");
		expect(formatRunStatus("queued")).toBe("排队");
		expect(formatRunStatus("waiting")).toBe("waiting");
		expect(formatConclusion("success")).toBe("成功");
		expect(formatConclusion("failure")).toBe("失败");
		expect(formatConclusion("cancelled")).toBe("取消");
		expect(formatConclusion("skipped")).toBe("跳过");
		expect(formatConclusion("timed_out")).toBe("timed_out");
		expect(formatConclusion(null)).toBe("—");
		expect(conclusionBadgeVariant("success")).toBe("green");
		expect(conclusionBadgeVariant("failure")).toBe("red");
		expect(conclusionBadgeVariant(null)).toBe("gray");
		expect(candyClass("green")).toContain("--basalt-accent-4");
		expect(candyClass("blue")).not.toBe(candyClass("green"));
		expect(candyClass("purple")).not.toBe(candyClass("gray"));
		expect(candyClass("amber")).toContain("--basalt-accent-6");
		expect(candyClass("red")).toContain("--basalt-accent-8");
		expect(reviewBadgeVariant("REVIEW_REQUIRED")).toBe("amber");
		expect(reviewBadgeVariant("OTHER")).toBe("gray");
		expect(visibilityBadgeVariant("public")).toBe("blue");
		expect(visibilityBadgeVariant("PRIVATE")).toBe("purple");
		expect(visibilityBadgeVariant("internal")).toBe("gray");
		expect(opportunityLabel("stale_push")).toBe("久未推送");
		expect(opportunityLabel("many_issues")).toBe("大量 Issue");
		expect(opportunityLabel("open_alerts")).toBe("有告警");
		expect(opportunityLabel("other")).toBe("other");
		expect(opportunityBadgeVariant("stale_push")).toBe("amber");
		expect(opportunityBadgeVariant("many_issues")).toBe("red");
		expect(opportunityBadgeVariant("open_alerts")).toBe("orange");
		expect(opportunityBadgeVariant("x")).toBe("gray");
		expect(reasonBadgeVariant("mention")).toBe("purple");
		expect(reasonBadgeVariant("assign")).toBe("sky");
		expect(reasonBadgeVariant("comment")).toBe("teal");
		expect(reasonBadgeVariant("author")).toBe("amber");
		expect(reasonBadgeVariant("security_alert")).toBe("red");
		expect(reasonBadgeVariant("subscribed")).toBe("gray");
		expect(sourceBadgeVariant("dependabot")).toBe("teal");
		expect(sourceBadgeVariant("code_scanning")).toBe("blue");
		expect(sourceBadgeVariant("secret_scanning")).toBe("purple");
		expect(sourceBadgeVariant("other")).toBe("gray");
		expect(takeChips(["a", "b"], 2)).toEqual({ shown: ["a", "b"], extra: 0 });
		expect(takeChips(["a", "b", "c"], 2)).toEqual({ shown: ["a", "b"], extra: 1 });
		expect(daysBetween("2026-09-10T00:00:00.000Z", "2026-09-01T00:00:00.000Z")).toBe(9);
		expect(daysBetween("2026-09-01T00:00:00.000Z", "2026-09-10T00:00:00.000Z")).toBe(0);
		expect(daysBetween("t", null)).toBe(9999);
		expect(daysBetween("t", "nope")).toBe(9999);
		expect(meterFilled(0, 10)).toBe(0);
		expect(meterFilled(5, 0)).toBe(0);
		expect(meterFilled(10, 10)).toBe(8);
		expect(meterFilled(1, 100)).toBe(1);
		expect(freshnessFilled(3)).toBe(8);
		expect(freshnessFilled(20)).toBe(5);
		expect(freshnessFilled(40)).toBe(3);
		expect(freshnessFilled(100)).toBe(1);
		expect(freshnessTone(3)).toBe("bg-basalt-chart-5");
		expect(freshnessTone(20)).toBe("bg-basalt-chart-5/75");
		expect(freshnessTone(40)).toBe("bg-basalt-chart-5/50");
		expect(freshnessTone(100)).toBe("bg-basalt-chart-5/25");
		expect(maxCount([1, 8, 3])).toBe(8);
		expect(maxCount([])).toBe(0);
		expect(churnFilled(0, 0)).toEqual({ adds: 0, dels: 0 });
		expect(churnFilled(8, 0)).toEqual({ adds: 8, dels: 0 });
		expect(churnFilled(1, 1)).toEqual({ adds: 4, dels: 4 });
	});
});
