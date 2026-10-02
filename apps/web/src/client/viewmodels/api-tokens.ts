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
export function loginRequest(search: string) {
	const params = new URLSearchParams(search);
	const scopes = (params.get("scopes") ?? "observations:read agent:read agent:write")
		.split(/[, ]+/)
		.filter(Boolean);
	const redirect_uri = params.get("redirect_uri") ?? "";
	const match = /^http:\/\/(127\.0\.0\.1|localhost):([0-9]{1,5})\/callback$/.exec(redirect_uri);
	const state = params.get("state") ?? "";
	const code_challenge = params.get("code_challenge") ?? "";
	if (
		!match ||
		Number(match[2]) < 1 ||
		Number(match[2]) > 65535 ||
		!state ||
		state.length > 512 ||
		[...state].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
		!/^[A-Za-z0-9_-]{43}$/.test(code_challenge) ||
		params.get("code_challenge_method") !== "S256" ||
		!scopes.length ||
		scopes.some((s) => !TOKEN_SCOPES.includes(s as (typeof TOKEN_SCOPES)[number]))
	)
		return null;
	return { redirect_uri, state, code_challenge, code_challenge_method: "S256" as const, scopes };
}
export async function authorizeAgent(
	request: NonNullable<ReturnType<typeof loginRequest>>,
	account: string,
	label: string,
) {
	return apiPost<{ redirect_uri: string; expires_at: string }>("cli/authorize", {
		...request,
		account_id: account,
		label,
		expires_in_days: 30,
		consent: true,
	});
}
