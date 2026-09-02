import { apiGet } from "../lib/api";
import { ApiError } from "../lib/errors";
import { cacheGeneration, ensureSession, getActiveAccountId } from "./session";

type Entry = {
	gen: number;
	account_id: string;
	body: { account_id: string };
};

const snapshots = new Map<string, Entry>();

export function clearSnapshots(): void {
	snapshots.clear();
}

export function putSnapshot(resource: string, body: { account_id: string }): void {
	snapshots.set(resource, {
		gen: cacheGeneration(),
		account_id: body.account_id,
		body,
	});
}

export function peekSnapshot<T extends { account_id: string }>(
	resource: string,
	accountId: string,
): T | undefined {
	const hit = snapshots.get(resource);
	if (!hit || hit.gen !== cacheGeneration() || hit.account_id !== accountId) {
		return undefined;
	}
	return hit.body as T;
}

export async function fetchKind<T extends { account_id: string }>(
	resource: string,
): Promise<T | { missing: true }> {
	const stamp = await ensureSession();
	try {
		const body = await apiGet<T>(resource);
		if (getActiveAccountId() !== stamp) {
			return { missing: true };
		}
		if (body.account_id !== stamp) {
			await ensureSession();
			return { missing: true };
		}
		putSnapshot(resource, body);
		return body;
	} catch (err) {
		if (err instanceof ApiError && err.code === "snapshot_missing") {
			return { missing: true };
		}
		throw err;
	}
}

export async function loadKind<T extends { account_id: string }>(
	resource: string,
): Promise<T | { missing: true }> {
	const stamp = await ensureSession();
	const cached = peekSnapshot<T>(resource, stamp);
	if (cached) {
		return cached;
	}
	return fetchKind<T>(resource);
}
