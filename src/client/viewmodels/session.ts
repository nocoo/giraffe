import { apiGet } from "../lib/api";
import { ApiError } from "../lib/errors";

export type AccountRow = {
	id: string;
	login: string;
	is_active: boolean;
};

let activeId: string | null = null;
let cacheGen = 0;
let sessionTick: Promise<string> | null = null;

export function getActiveAccountId(): string | null {
	return activeId;
}

export function setActiveAccountId(id: string | null): void {
	if (activeId !== id) {
		cacheGen += 1;
	}
	activeId = id;
}

export function cacheGeneration(): number {
	return cacheGen;
}

export async function ensureSession(): Promise<string> {
	if (sessionTick) {
		return sessionTick;
	}
	sessionTick = (async () => {
		const body = await apiGet<{ accounts: AccountRow[] }>("accounts");
		const active = body.accounts.find((row) => row.is_active);
		if (!active) {
			setActiveAccountId(null);
			throw new ApiError(409, "account_missing", "no active account");
		}
		setActiveAccountId(active.id);
		return active.id;
	})();
	try {
		return await sessionTick;
	} finally {
		sessionTick = null;
	}
}
