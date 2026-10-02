import type { Context } from "hono";
import type { RefreshWindow } from "../../lib/refresh-times";
import type { AppVars, Env } from "../env";
import { getActiveAccount } from "../lib/db/accounts";
import { ApiError, jsonOk } from "../lib/errors";

export async function getRefreshTimes(c: Context<{ Bindings: Env; Variables: AppVars }>) {
	const db = c.get("db");
	const account = await getActiveAccount(db);
	if (!account) throw new ApiError(409, "account_missing", "no active account");
	const rows = await db
		.prepare(`SELECT
 json_extract(payload,'$.startedAt') AS startedAt,
 json_extract(payload,'$.finishedAt') AS finishedAt
 FROM factory_runs WHERE account_id=? AND status NOT IN ('running','paused')
 AND json_extract(payload,'$.finishedAt') IS NOT NULL
 AND EXISTS(SELECT 1 FROM json_each(payload,'$.steps') WHERE json_extract(value,'$.status')='success' AND json_extract(value,'$.kind') IN ('snapshot','commit','publish'))
 ORDER BY finishedAt DESC LIMIT 20`)
		.bind(account.id)
		.all<RefreshWindow>();
	return jsonOk({ account_id: account.id, runs: rows.results }, 200, {
		"cache-control": "private, no-store",
	});
}
