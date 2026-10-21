import type { Context } from "hono";
import type { AppVars, Env } from "../env";
import { getActiveAccount } from "../lib/db/accounts";
import { ApiError, jsonOk } from "../lib/errors";
import { readCiObservation } from "../lib/machine-observations";
import { repoPolicy } from "../lib/repo-statistics";
import { snapshotScope } from "../lib/snapshot-scope";

export async function getCi(c: Context<{ Bindings: Env; Variables: AppVars }>): Promise<Response> {
	const scope = snapshotScope(c.req.queries("scope"));
	const db = c.get("db");
	const account = await getActiveAccount(db);
	if (!account) throw new ApiError(409, "account_missing", "no active account");
	const policy = await repoPolicy(db, account.id, undefined, scope);
	return jsonOk(
		{ ...(await readCiObservation(db, account.id, policy, true)), account_id: account.id },
		200,
		{ "cache-control": "private, no-store" },
	);
}
