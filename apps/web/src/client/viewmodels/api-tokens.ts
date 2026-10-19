import { apiGet, apiPost, apiWrite } from "../lib/api";
export type ApiTokenRow = {
	id: string;
	account_id: string;
	label: string;
	scopes: string[];
	creator: string;
	created_at: string;
	expires_at: string;
	revoked_at: string | null;
	last_used_at: string | null;
};
export const TOKEN_SCOPES = [
	"observations:read",
	"agent:read",
	"agent:write",
	"app:read",
	"app:write",
] as const;
export const tokenScopesLabel: Record<string, string> = {
	"observations:read": "读取 GitHub 快照",
	"agent:read": "读取 Agent 数据",
	"agent:write": "写入 Agent 数据",
	"app:read": "读取应用配置",
	"app:write": "修改配置与发起刷新",
};
export const listTokens = (account: string) =>
	apiGet<{ account_id: string; items: ApiTokenRow[] }>(
		`tokens?account_id=${encodeURIComponent(account)}`,
	);
export const createToken = (account: string, label: string, scopes: string[], days: number) =>
	apiPost<ApiTokenRow & { token: string }>("tokens", {
		account_id: account,
		label,
		scopes,
		expires_in_days: days,
	});
export const updateToken = (account: string, id: string, label: string, scopes: string[]) =>
	apiWrite<ApiTokenRow>(`tokens/${encodeURIComponent(id)}`, "PATCH", {
		account_id: account,
		label,
		scopes,
	});
export const revokeToken = (account: string, id: string) =>
	apiWrite<void>(`tokens/${encodeURIComponent(id)}`, "DELETE", { account_id: account });
