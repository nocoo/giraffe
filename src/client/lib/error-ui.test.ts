// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
	catchLoad,
	errorUi,
	missingTitle,
	reportError,
	reportOk,
	subscribeErrorUi,
} from "./error-ui";
import { ApiError } from "./errors";

describe("errorUi", () => {
	it("maps envelope codes to page, empty, field, or toast", () => {
		expect(errorUi(new Error("x"))).toEqual({ kind: "toast", message: "请求失败" });
		expect(errorUi(new ApiError(401, "access_unauthorized", "no"))).toEqual({ kind: "access" });
		expect(errorUi(new ApiError(409, "account_missing", "no"))).toEqual({
			kind: "account_missing",
		});
		expect(errorUi(new ApiError(409, "snapshot_missing", "no"))).toEqual({
			kind: "empty",
			title: "没有快照",
		});
		expect(errorUi(new ApiError(400, "scopes_missing", "need repo"))).toEqual({
			kind: "field",
			message: "need repo",
		});
		expect(errorUi(new ApiError(400, "validation_failed", "bad"))).toEqual({
			kind: "field",
			message: "bad",
		});
		expect(errorUi(new ApiError(401, "github_unauthorized", "no"))).toEqual({
			kind: "toast",
			message: "GitHub 认证失败",
		});
		expect(errorUi(new ApiError(409, "account_conflict", "c"))).toEqual({
			kind: "toast",
			message: "账号已切换",
		});
		expect(errorUi(new ApiError(500, "internal_error", "boom"))).toEqual({
			kind: "toast",
			message: "boom",
		});
		expect(errorUi(new ApiError(404, "not_found", "gone"))).toEqual({
			kind: "empty",
			title: "未找到",
		});
		expect(missingTitle({ missing: true, title: "未找到" })).toBe("未找到");
		expect(missingTitle({ missing: true })).toBe("没有快照");
	});

	it("notifies subscribers and maps load failures", () => {
		const seen: string[] = [];
		const stop = subscribeErrorUi((ui) => {
			seen.push(ui.kind);
		});
		expect(reportError(new ApiError(401, "access_unauthorized", "no")).kind).toBe("access");
		expect(seen).toEqual(["access"]);
		stop();
		expect(catchLoad(new ApiError(409, "snapshot_missing", "n"), () => undefined)).toEqual({
			missing: true,
			title: "没有快照",
		});
		expect(catchLoad(new ApiError(404, "not_found", "gone"), () => undefined)).toEqual({
			missing: true,
			title: "未找到",
		});
		expect(catchLoad(new ApiError(409, "account_missing", "n"), () => undefined)).toEqual({
			missing: true,
			title: "没有快照",
		});
		const toasts: string[] = [];
		expect(
			catchLoad(new ApiError(502, "github_error", "x"), (message) => toasts.push(message)),
		).toBe(undefined);
		expect(toasts).toEqual(["GitHub 请求失败"]);
		const kinds: string[] = [];
		const stopOk = subscribeErrorUi((ui) => {
			kinds.push(ui.kind);
		});
		reportOk();
		stopOk();
		expect(kinds).toEqual(["ok"]);
	});
});
