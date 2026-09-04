// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
	churnFilled,
	daysBetween,
	fillTextColor,
	formatConclusion,
	formatCount,
	formatDate,
	formatDays,
	formatDelta,
	formatHealth,
	formatReview,
	formatRunStatus,
	formatVisibility,
	freshnessFilled,
	freshnessTone,
	healthBadgeVariant,
	initials,
	labelFill,
	languageColor,
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
		expect(languageColor("TypeScript")).toBe("#3178c6");
		expect(languageColor("UnknownLang")).toMatch(/^hsl\(\d+ 42% 48%\)$/);
		expect(initials("")).toBe("?");
		expect(initials("  ")).toBe("?");
		expect(initials("dev")).toBe("DE");
		expect(initials("Zheng Li")).toBe("ZL");
		expect(formatHealth("strong")).toBe("健康");
		expect(formatHealth("watch")).toBe("观察");
		expect(formatHealth("risky")).toBe("风险");
		expect(healthBadgeVariant("strong")).toBe("success");
		expect(healthBadgeVariant("watch")).toBe("orange");
		expect(healthBadgeVariant("risky")).toBe("red");
		expect(formatVisibility("private")).toBe("私有");
		expect(formatVisibility("public")).toBe("公开");
		expect(formatVisibility("PUBLIC")).toBe("公开");
		expect(formatVisibility("internal")).toBe("internal");
		expect(severityBadgeVariant("critical")).toBe("red");
		expect(severityBadgeVariant("HIGH")).toBe("red");
		expect(severityBadgeVariant("medium")).toBe("orange");
		expect(severityBadgeVariant("low")).toBe("teal");
		expect(severityBadgeVariant("unknown")).toBe("outline");
		expect(formatReview(null)).toBe("—");
		expect(formatReview("APPROVED")).toBe("已批准");
		expect(formatReview("CHANGES_REQUESTED")).toBe("需修改");
		expect(formatReview("REVIEW_REQUIRED")).toBe("待审查");
		expect(formatReview("OTHER")).toBe("OTHER");
		expect(reviewBadgeVariant("APPROVED")).toBe("success");
		expect(reviewBadgeVariant("CHANGES_REQUESTED")).toBe("red");
		expect(reviewBadgeVariant(null)).toBe("outline");
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
		expect(reviewBadgeVariant("REVIEW_REQUIRED")).toBe("orange");
		expect(reviewBadgeVariant("OTHER")).toBe("outline");
		expect(visibilityBadgeVariant("public")).toBe("blue");
		expect(visibilityBadgeVariant("PRIVATE")).toBe("purple");
		expect(visibilityBadgeVariant("internal")).toBe("outline");
		expect(opportunityLabel("stale_push")).toBe("久未推送");
		expect(opportunityLabel("many_issues")).toBe("大量 Issue");
		expect(opportunityLabel("open_alerts")).toBe("有告警");
		expect(opportunityLabel("other")).toBe("other");
		expect(opportunityBadgeVariant("stale_push")).toBe("orange");
		expect(opportunityBadgeVariant("many_issues")).toBe("red");
		expect(opportunityBadgeVariant("open_alerts")).toBe("purple");
		expect(opportunityBadgeVariant("x")).toBe("secondary");
		expect(reasonBadgeVariant("mention")).toBe("purple");
		expect(reasonBadgeVariant("assign")).toBe("blue");
		expect(reasonBadgeVariant("comment")).toBe("teal");
		expect(reasonBadgeVariant("author")).toBe("orange");
		expect(reasonBadgeVariant("security_alert")).toBe("red");
		expect(reasonBadgeVariant("subscribed")).toBe("outline");
		expect(sourceBadgeVariant("dependabot")).toBe("teal");
		expect(sourceBadgeVariant("code_scanning")).toBe("blue");
		expect(sourceBadgeVariant("secret_scanning")).toBe("purple");
		expect(sourceBadgeVariant("other")).toBe("outline");
		expect(takeChips(["a", "b"], 2)).toEqual({ shown: ["a", "b"], extra: 0 });
		expect(takeChips(["a", "b", "c"], 2)).toEqual({ shown: ["a", "b"], extra: 1 });
		expect(fillTextColor("1d4ed8")).toBe("#ffffff");
		expect(fillTextColor("#f1e05a")).toBe("#111111");
		expect(fillTextColor("nope")).toBe("#ffffff");
		expect(labelFill("d73a4a")).toBe("#d73a4a");
		expect(labelFill("#abc")).toBe("#abc");
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
		expect(freshnessTone(3)).toBe("bg-basalt-heatmap-green-3");
		expect(freshnessTone(20)).toBe("bg-basalt-chart-7");
		expect(freshnessTone(40)).toBe("bg-basalt-chart-8");
		expect(freshnessTone(100)).toBe("bg-basalt-chart-10");
		expect(maxCount([1, 8, 3])).toBe(8);
		expect(maxCount([])).toBe(0);
		expect(churnFilled(0, 0)).toEqual({ adds: 0, dels: 0 });
		expect(churnFilled(8, 0)).toEqual({ adds: 8, dels: 0 });
		expect(churnFilled(1, 1)).toEqual({ adds: 4, dels: 4 });
	});
});
