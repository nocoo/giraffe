import { describe, expect, it } from "vitest";
import { errorUi } from "./error-ui";
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
	});
});
