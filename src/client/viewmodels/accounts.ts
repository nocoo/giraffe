import { apiDelete, apiGet, apiPost } from "../lib/api";
import { ApiError } from "../lib/errors";
import { requestRefresh } from "./refresh";
import { setActiveAccountId } from "./session";

export type PublicAccount = {
	id: string;
	login: string;
	avatar_url: string;
	token_last4: string;
	scopes: string;
	capabilities: Record<string, boolean>;
	is_active: boolean;
};

export function emptyToken(): string {
	return "";
}

export function shouldRefreshOnCreate(account: Pick<PublicAccount, "is_active">): boolean {
	return account.is_active;
}

export function accountFieldError(err: unknown): string | null {
	if (
		err instanceof ApiError &&
		(err.code === "scopes_missing" || err.code === "validation_failed")
	) {
		return err.message;
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

export async function createAccount(token: string): Promise<PublicAccount> {
	const account = await apiPost<PublicAccount>("accounts", { token });
	if (shouldRefreshOnCreate(account)) {
		setActiveAccountId(account.id);
		await requestRefresh(["repos"]);
	}
	return account;
}

export async function activateAccount(id: string): Promise<void> {
	await apiPost(`accounts/${id}/activate`);
	setActiveAccountId(id);
	await requestRefresh(["repos"]);
}

export async function deleteAccount(id: string): Promise<void> {
	await apiDelete(`accounts/${id}`);
}
