import { apiDelete, apiGet, apiPost } from "../lib/api";
import { ApiError } from "../lib/errors";
import { clearRefreshQueue, requestRefresh } from "./refresh";
import { getActiveAccountId, setActiveAccountId } from "./session";

export type PublicAccount = {
	id: string;
	login: string;
	avatar_url: string;
	token_last4: string;
	scopes: string;
	capabilities: Record<string, boolean>;
	is_active: boolean;
};

export type AccountAddPhase = "idle" | "saving" | "syncing";

export function emptyToken(): string {
	return "";
}

export function shouldRefreshOnCreate(account: Pick<PublicAccount, "is_active">): boolean {
	return account.is_active;
}

export function accountAddBusy(phase: AccountAddPhase): boolean {
	return phase !== "idle";
}

export function canSubmitAccount(token: string, phase: AccountAddPhase): boolean {
	return token.length > 0 && !accountAddBusy(phase);
}

export function accountAddLabel(phase: AccountAddPhase): string {
	if (phase === "saving") {
		return "正在添加…";
	}
	if (phase === "syncing") {
		return "正在同步…";
	}
	return "添加账号";
}

export function accountAddHint(phase: AccountAddPhase): string | null {
	if (phase === "saving") {
		return "正在校验令牌并保存账号";
	}
	if (phase === "syncing") {
		return "账号已保存，正在同步仓库";
	}
	return null;
}

export function accountFieldError(err: unknown): string | null {
	if (!(err instanceof ApiError)) {
		return null;
	}
	if (err.code === "scopes_missing" || err.code === "validation_failed") {
		return err.message;
	}
	if (err.code === "github_unauthorized") {
		return "令牌无效";
	}
	if (err.code === "db_error") {
		return "保存失败";
	}
	if (err.code === "encryption_misconfigured") {
		return "加密未配置";
	}
	return null;
}

export function accountsArePublic(rows: PublicAccount[]): boolean {
	return rows.every((row) => !("token_ciphertext" in row) && !("token" in row));
}

export async function loadAccounts(): Promise<PublicAccount[]> {
	const body = await apiGet<{ accounts: PublicAccount[] }>("accounts");
	return body.accounts;
}

export async function createAccount(
	token: string,
	onPhase?: (phase: AccountAddPhase) => void,
): Promise<PublicAccount> {
	onPhase?.("saving");
	const account = await apiPost<PublicAccount>("accounts", { token });
	if (shouldRefreshOnCreate(account)) {
		setActiveAccountId(account.id);
		onPhase?.("syncing");
		try {
			await requestRefresh(["repos"]);
		} catch {
			// account row exists even if the first repos refresh fails
		}
	}
	return account;
}

export async function activateAccount(id: string): Promise<void> {
	await apiPost(`accounts/${id}/activate`);
	clearRefreshQueue();
	setActiveAccountId(id);
	try {
		await requestRefresh(["repos"]);
	} catch {
		// account is already active even if the first repos refresh fails
	}
}

export async function deleteAccount(id: string): Promise<void> {
	await apiDelete(`accounts/${id}`);
	if (getActiveAccountId() === id) {
		clearRefreshQueue();
		setActiveAccountId(null);
	}
}
