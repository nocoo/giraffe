import { apiGet, apiPost } from "../lib/api";
import { ensureSession, getActiveAccountId } from "./session";

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

function normalizeKinds(kinds: string | string[] | undefined): string | string[] | undefined {
	if (kinds === undefined || kinds === "all") {
		return kinds;
	}
	if (typeof kinds === "string") {
		return [kinds];
	}
	return [...kinds].sort();
}

function keyOf(stamp: string, kinds: string | string[] | undefined): string {
	return `${stamp}:${JSON.stringify(normalizeKinds(kinds) ?? null)}`;
}

function writtenKinds(result: RefreshBody, requested: string | string[] | undefined): string[] {
	if (result.kinds) {
		return result.kinds;
	}
	const normalized = normalizeKinds(requested);
	if (Array.isArray(normalized)) {
		return normalized;
	}
	return ["repos", "issues", "prs", "alerts", "notifications"];
}

async function followUp(
	stamp: string,
	result: RefreshBody,
	requested: string | string[] | undefined,
): Promise<void> {
	if (getActiveAccountId() !== stamp) {
		return;
	}
	const written = writtenKinds(result, requested);
	if (!written.includes("insights")) {
		await apiGet("insights").catch(() => undefined);
	}
	if (!written.includes("digest") && written.includes("repos")) {
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
	const normalized = normalizeKinds(kinds);
	if (normalized !== undefined) {
		body.kinds = normalized;
	}
	const result = await apiPost<RefreshBody>("refresh", body);
	if (result.account_id !== undefined && result.account_id !== stamp) {
		await ensureSession();
		return null;
	}
	await followUp(stamp, result, kinds);
	if (getActiveAccountId() !== stamp) {
		return null;
	}
	return result;
}

export async function requestRefresh(kinds?: string | string[]): Promise<RefreshBody | null> {
	const stamp = await ensureSession();
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
