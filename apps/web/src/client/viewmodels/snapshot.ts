import { apiGet } from "../lib/api";
import { ApiError } from "../lib/errors";
import { ensureSession, getActiveAccountId } from "./session";

export async function fetchKindAs<T extends { account_id: string }>(
	resource: string,
	stamp: string,
): Promise<T | { missing: true }> {
	if (getActiveAccountId() !== stamp) {
		return { missing: true };
	}
	try {
		const body = await apiGet<T>(resource);
		if (getActiveAccountId() !== stamp) {
			return { missing: true };
		}
		if (body.account_id !== stamp) {
			await ensureSession();
			return { missing: true };
		}
		return body;
	} catch (err) {
		if (err instanceof ApiError && err.code === "snapshot_missing") {
			return { missing: true };
		}
		throw err;
	}
}

export async function fetchKind<T extends { account_id: string }>(
	resource: string,
): Promise<T | { missing: true }> {
	const stamp = await ensureSession();
	return fetchKindAs<T>(resource, stamp);
}

export async function loadKind<T extends { account_id: string }>(
	resource: string,
): Promise<T | { missing: true }> {
	// The durable factory job can finish while this page is unmounted.
	// Navigation reads the latest saved data; GET never starts collection.
	return fetchKind<T>(resource);
}
