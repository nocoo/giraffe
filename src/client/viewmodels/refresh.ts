import { apiPost } from "../lib/api";
import { ApiError } from "../lib/errors";
import { ensureSession, getActiveAccountId } from "./session";
import { fetchKindAs, putSnapshot } from "./snapshot";

export type RefreshBody = {
	account_id?: string;
	kinds?: string[];
	fetched_at?: string;
	truncated?: boolean;
	truncated_kinds?: string[];
} & Record<string, unknown>;

const jobs = new Map<string, Promise<RefreshBody | null>>();
const starting = new Map<string, Promise<RefreshBody | null>>();
let tail: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

export function refreshInFlight(): boolean {
	return jobs.size > 0 || starting.size > 0;
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
	jobs.clear();
	starting.clear();
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
	const current = await ensureSession();
	if (current !== stamp) {
		return;
	}
	const written = writtenKinds(result, requested);
	if (!written.includes("insights")) {
		await fetchKindAs("insights", stamp);
	}
	if (!written.includes("digest") && written.includes("repos")) {
		await fetchKindAs("digest", stamp);
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
			const current = await ensureSession();
			if (current !== stamp) {
				return;
			}
			await fetchKindAs(resourceOfKind(kind), stamp);
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
	if (result.account_id !== stamp || getActiveAccountId() !== stamp) {
		await ensureSession();
		return null;
	}
	await applyResult(stamp, result, kinds);
	if (getActiveAccountId() !== stamp) {
		return null;
	}
	return result;
}

export function requestRefresh(kinds?: string | string[]): Promise<RefreshBody | null> {
	const known = getActiveAccountId();
	const preKey = `${known ?? ""}:${JSON.stringify(normalizeKinds(kinds) ?? null)}`;
	if (known) {
		const existing = jobs.get(keyOf(known, kinds));
		if (existing) {
			return existing;
		}
	}
	const pendingStart = starting.get(preKey);
	if (pendingStart) {
		return pendingStart;
	}
	const started: Promise<RefreshBody | null> = ensureSession().then(
		(stamp) => {
			starting.delete(preKey);
			if (known !== null && stamp !== known) {
				notifyRefresh();
				return null;
			}
			const key = keyOf(stamp, kinds);
			const existing = jobs.get(key);
			if (existing) {
				return existing;
			}
			const job = tail.then(() => execute(stamp, kinds));
			jobs.set(key, job);
			notifyRefresh();
			tail = job.then(
				() => {
					if (jobs.get(key) === job) {
						jobs.delete(key);
						notifyRefresh();
					}
				},
				() => {
					if (jobs.get(key) === job) {
						jobs.delete(key);
						notifyRefresh();
					}
				},
			);
			return job;
		},
		(err: unknown) => {
			starting.delete(preKey);
			notifyRefresh();
			throw err;
		},
	);
	starting.set(preKey, started);
	notifyRefresh();
	return started;
}
