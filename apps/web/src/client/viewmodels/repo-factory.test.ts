import { describe, expect, it } from "vitest";
import {
	checksStatus,
	isRecordNumbered,
	issueReason,
	recordNumber,
	recordStateOptions,
	recordStatus,
	runDuration,
} from "./repo-factory";

describe("factory record presentation", () => {
	it("keeps unknown record states visible and tones the known ones", () => {
		expect(recordStatus("merged")).toEqual({ label: "已合并", tone: "purple" });
		expect(recordStatus("committed")).toEqual({ label: "已提交", tone: "gray" });
		expect(recordStatus("suspended")).toEqual({ label: "suspended", tone: "gray" });
	});

	it("offers state filters only for streams that carry a status", () => {
		expect(recordStateOptions("prs").map((o) => o.value)).toEqual(["", "open", "merged", "closed"]);
		expect(recordStateOptions("actions").map((o) => o.value)).toEqual([
			"",
			"success",
			"failure",
			"cancelled",
		]);
		expect(recordStateOptions("actions").map((o) => o.label)).toEqual([
			"全部状态",
			"成功",
			"失败",
			"取消",
		]);
		expect(recordStateOptions("commits")).toEqual([{ value: "", label: "全部状态" }]);
		expect(recordStateOptions("dependencies")).toEqual([{ value: "", label: "全部状态" }]);
		expect(isRecordNumbered("prs")).toBe(true);
		expect(isRecordNumbered("issues")).toBe(true);
		expect(isRecordNumbered("releases")).toBe(false);
	});

	it("reads the GitHub number from the record URL", () => {
		expect(recordNumber({ url: "https://github.com/nocoo/app/pull/115" })).toBe("#115");
		expect(recordNumber({ url: "https://github.com/nocoo/app/issues/47" })).toBe("#47");
		expect(recordNumber({ url: "https://github.com/nocoo/app/releases/tag/v1.0.0" })).toBe("");
	});

	it("formats CI run duration in whole units", () => {
		expect(runDuration({ activityRun: { duration_s: 36 } as never })).toBe("36s");
		expect(runDuration({ activityRun: { duration_s: 90 } as never })).toBe("1m 30s");
		expect(runDuration({ activityRun: { duration_s: 120 } as never })).toBe("2m");
		expect(runDuration({ activityRun: { duration_s: null } as never })).toBe("—");
		expect(runDuration({})).toBe("—");
	});

	it("labels issue close reasons and PR check states", () => {
		expect(issueReason("completed")).toBe("完成");
		expect(issueReason("not_planned")).toBe("未计划");
		expect(issueReason("reopened")).toBe("重新打开");
		expect(issueReason("duplicate")).toBe("duplicate");
		expect(issueReason(null)).toBe("");
		expect(checksStatus("SUCCESS")).toEqual({ label: "检查通过", tone: "green" });
		expect(checksStatus("FAILURE")).toEqual({ label: "检查失败", tone: "red" });
		expect(checksStatus("QUEUED")).toEqual({ label: "QUEUED", tone: "gray" });
		expect(checksStatus(null)).toBeNull();
	});
});
