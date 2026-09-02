import type { Context } from "hono";
import type { AppVars, Env } from "../env";
import { getActiveAccount } from "../lib/db/accounts";
import { readSnapshot } from "../lib/db/snapshots";
import { ApiError, jsonOk } from "../lib/errors";

export async function snapshotGet(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
	logical: string,
): Promise<Response> {
	const account = await getActiveAccount(c.get("db"));
	if (!account) {
		throw new ApiError(409, "account_missing", "no active account");
	}
	const snap = await readSnapshot(c.get("db"), account.id, logical);
	if (!snap) {
		throw new ApiError(409, "snapshot_missing", `no snapshot for ${logical}`);
	}
	return jsonOk({ ...snap, account_id: account.id });
}

export function repoParts(owner: string, name: string): { owner: string; name: string } {
	const ok = /^[A-Za-z0-9_.-]+$/;
	if (
		!ok.test(owner) ||
		!ok.test(name) ||
		owner === "." ||
		owner === ".." ||
		name === "." ||
		name === ".."
	) {
		throw new ApiError(400, "validation_failed", "invalid repo");
	}
	return { owner, name };
}
