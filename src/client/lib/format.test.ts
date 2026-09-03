// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
	formatConclusion,
	formatCount,
	formatDate,
	formatDays,
	formatDelta,
	formatHealth,
	formatReview,
	formatRunStatus,
	formatVisibility,
	healthBadgeVariant,
	initials,
	languageColor,
	reviewBadgeVariant,
	severityBadgeVariant,
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
		expect(healthBadgeVariant("watch")).toBe("warning");
		expect(healthBadgeVariant("risky")).toBe("error");
		expect(formatVisibility("private")).toBe("私有");
		expect(formatVisibility("public")).toBe("公开");
		expect(formatVisibility("internal")).toBe("internal");
		expect(severityBadgeVariant("critical")).toBe("error");
		expect(severityBadgeVariant("HIGH")).toBe("error");
		expect(severityBadgeVariant("medium")).toBe("warning");
		expect(severityBadgeVariant("low")).toBe("secondary");
		expect(severityBadgeVariant("unknown")).toBe("outline");
		expect(formatReview(null)).toBe("—");
		expect(formatReview("APPROVED")).toBe("已批准");
		expect(formatReview("CHANGES_REQUESTED")).toBe("需修改");
		expect(formatReview("REVIEW_REQUIRED")).toBe("待审查");
		expect(formatReview("OTHER")).toBe("OTHER");
		expect(reviewBadgeVariant("APPROVED")).toBe("success");
		expect(reviewBadgeVariant("CHANGES_REQUESTED")).toBe("warning");
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
		expect(reviewBadgeVariant("REVIEW_REQUIRED")).toBe("secondary");
		expect(reviewBadgeVariant("OTHER")).toBe("outline");
	});
});
