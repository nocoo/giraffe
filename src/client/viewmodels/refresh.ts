import { apiGet, apiPost } from "../lib/api";
import { getActiveAccountId } from "./session";

export type RefreshBody = {
	account_id?: string;
	kinds?: string[];
	fetched_at?: string;
	truncated?: boolean;
	truncated_kinds?: string[];
} & Record<string, unknown>;

type Pending = {
	key: string;
	promise: Promise<RefreshBody | null>;
};

let pending: Pending | null = null;
let tail: Promise<void> = Promise.resolve();

export function refreshInFlight(): boolean {
	return pending !== null;
}

export function clearRefreshQueue(): void {
	pending = null;
	tail = Promise.resolve();
}

function keyOf(stamp: string, kinds: string | string[] | undefined): string {
	return `${stamp}:${JSON.stringify(kinds ?? null)}`;
}

async function followUp(stamp: string, result: RefreshBody): Promise<void> {
	if (getActiveAccountId() !== stamp) {
		return;
	}
	if (result.account_id !== undefined && result.account_id !== stamp) {
		return;
	}
	const written = result.kinds;
	if (!written?.includes("insights")) {
		await apiGet("insights").catch(() => undefined);
	}
	if (!written?.includes("digest")) {
		await apiGet("digest").catch(() => undefined);
	}
}

async function execute(
	stamp: string,
	kinds: string | string[] | undefined,
): Promise<RefreshBody | null> {
	if (getActiveAccountId() !== stamp) {
		return null;
	}
	const body: { account_id: string; kinds?: string | string[] } = { account_id: stamp };
	if (kinds !== undefined) {
		body.kinds = kinds;
	}
	const result = await apiPost<RefreshBody>("refresh", body);
	await followUp(stamp, result);
	if (getActiveAccountId() !== stamp) {
		return null;
	}
	return result;
}

export function requestRefresh(kinds?: string | string[]): Promise<RefreshBody | null> {
	const stamp = getActiveAccountId();
	if (!stamp) {
		return Promise.resolve(null);
	}
	const key = keyOf(stamp, kinds);
	if (pending?.key === key) {
		return pending.promise;
	}
	const job = tail.then(() => execute(stamp, kinds));
	pending = { key, promise: job };
	tail = job.then(
		() => {
			if (pending?.key === key) {
				pending = null;
			}
		},
		() => {
			if (pending?.key === key) {
				pending = null;
			}
		},
	);
	return job;
}
