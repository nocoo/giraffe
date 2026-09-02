import { apiPost } from "../lib/api";
import { ApiError } from "../lib/errors";
import { ensureSession, getActiveAccountId } from "./session";
import { fetchKind, putSnapshot } from "./snapshot";

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
const listeners = new Set<() => void>();

export function refreshInFlight(): boolean {
	return pending !== null;
}

export function subscribeRefresh(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function notifyRefresh(): void {
	for (const listener of listeners) {
		listener();
	}
}

export function clearRefreshQueue(): void {
	pending = null;
	tail = Promise.resolve();
	notifyRefresh();
}

export function resourceOfKind(kind: string): string {
	if (!kind.startsWith("repo:")) {
		return kind;
	}
	const rest = kind.slice("repo:".length);
	const idx = rest.lastIndexOf(":");
	const repo = rest.slice(0, idx);
	const tab = rest.slice(idx + 1);
	if (tab === "details") {
		return `repos/${repo}`;
	}
	return `repos/${repo}/${tab}`;
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

function isSingleKind(result: RefreshBody, requested: string | string[] | undefined): boolean {
	if (result.kinds) {
		return false;
	}
	const normalized = normalizeKinds(requested);
	return Array.isArray(normalized) && normalized.length === 1;
}

async function followUp(
	stamp: string,
	result: RefreshBody,
	requested: string | string[] | undefined,
): Promise<void> {
	if (getActiveAccountId() !== stamp) {
		return;
	}
	await ensureSession();
	if (getActiveAccountId() !== stamp) {
		return;
	}
	const written = writtenKinds(result, requested);
	if (!written.includes("insights")) {
		await fetchKind("insights");
	}
	if (!written.includes("digest") && written.includes("repos")) {
		await fetchKind("digest");
	}
}

async function applyResult(
	stamp: string,
	result: RefreshBody,
	requested: string | string[] | undefined,
): Promise<void> {
	if (isSingleKind(result, requested)) {
		const kind = writtenKinds(result, requested)[0];
		if (kind) {
			putSnapshot(resourceOfKind(kind), result as { account_id: string });
		}
	} else {
		for (const kind of writtenKinds(result, requested)) {
			if (getActiveAccountId() !== stamp) {
				return;
			}
			await fetchKind(resourceOfKind(kind));
		}
	}
	await followUp(stamp, result, requested);
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
	let result: RefreshBody;
	try {
		result = await apiPost<RefreshBody>("refresh", body);
	} catch (err) {
		if (err instanceof ApiError && err.code === "account_conflict") {
			await ensureSession();
		}
		throw err;
	}
	if (result.account_id !== stamp) {
		await ensureSession();
		return null;
	}
	await applyResult(stamp, result, kinds);
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
	notifyRefresh();
	tail = job.then(
		() => {
			if (pending?.key === key) {
				pending = null;
				notifyRefresh();
			}
		},
		() => {
			if (pending?.key === key) {
				pending = null;
				notifyRefresh();
			}
		},
	);
	return job;
}
