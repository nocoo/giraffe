import { apiGet } from "../lib/api";
import { ApiError } from "../lib/errors";
import { ensureSession, getActiveAccountId } from "./session";

export async function loadKind<T extends { account_id?: string }>(
	resource: string,
): Promise<T | { missing: true }> {
	const stamp = await ensureSession();
	try {
		const body = await apiGet<T>(resource);
		if (getActiveAccountId() !== stamp) {
			return { missing: true };
		}
		if (body.account_id !== undefined && body.account_id !== stamp) {
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
