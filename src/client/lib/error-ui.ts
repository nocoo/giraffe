import { ApiError } from "./errors";

export type ErrorUi =
	| { kind: "access" }
	| { kind: "account_missing" }
	| { kind: "empty"; title: string }
	| { kind: "field"; message: string }
	| { kind: "toast"; message: string };

const TOAST: Record<string, string> = {
	github_unauthorized: "GitHub 认证失败",
	github_forbidden: "没有 GitHub 权限",
	origin_forbidden: "来源不被允许",
	method_not_allowed: "方法不允许",
	account_conflict: "账号已切换",
	capability_missing: "缺少 notifications 权限",
	github_rate_limited: "GitHub 限流",
	github_error: "GitHub 请求失败",
};

export function errorUi(err: unknown): ErrorUi {
	if (!(err instanceof ApiError)) {
		return { kind: "toast", message: "请求失败" };
	}
	if (err.code === "access_unauthorized") {
		return { kind: "access" };
	}
	if (err.code === "account_missing") {
		return { kind: "account_missing" };
	}
	if (err.code === "snapshot_missing") {
		return { kind: "empty", title: "没有快照" };
	}
	if (err.code === "scopes_missing" || err.code === "validation_failed") {
		return { kind: "field", message: err.message };
	}
	const toast = TOAST[err.code];
	if (toast) {
		return { kind: "toast", message: toast };
	}
	return { kind: "toast", message: err.message };
}
