import { ApiError } from "./errors";

export type ErrorUi =
	| { kind: "access" }
	| { kind: "account_missing" }
	| { kind: "empty"; title: string }
	| { kind: "field"; message: string }
	| { kind: "toast"; message: string }
	| { kind: "ok" };

const TOAST: Record<string, string> = {
	github_unauthorized: "GitHub 认证失败",
	github_forbidden: "没有 GitHub 权限",
	origin_forbidden: "来源不被允许",
	method_not_allowed: "方法不允许",
	account_conflict: "账号已切换",
	capability_missing: "缺少 notifications 权限",
	github_rate_limited: "GitHub 限流",
	github_error: "GitHub 请求失败",
	db_error: "数据库错误",
	encryption_misconfigured: "无法解密令牌，请在设置里重新添加 PAT",
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
	if (err.code === "not_found") {
		return { kind: "empty", title: "未找到" };
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

const listeners = new Set<(ui: ErrorUi) => void>();

export function subscribeErrorUi(listener: (ui: ErrorUi) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function reportError(err: unknown): ErrorUi {
	const ui = errorUi(err);
	for (const listener of listeners) {
		listener(ui);
	}
	return ui;
}

export function reportOk(): void {
	for (const listener of listeners) {
		listener({ kind: "ok" });
	}
}

export function missingTitle(snap: { missing: true; title?: unknown }): string {
	return typeof snap.title === "string" ? snap.title : "没有快照";
}

export function catchLoad(
	err: unknown,
	notify: (message: string) => void,
): { missing: true; title: string } | undefined {
	const ui = reportError(err);
	if (ui.kind === "toast") {
		notify(ui.message);
	}
	if (ui.kind === "empty") {
		return { missing: true, title: ui.title };
	}
	if (ui.kind === "account_missing") {
		return { missing: true, title: "没有快照" };
	}
	return undefined;
}
