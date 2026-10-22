import type { Context } from "hono";
import type { AppVars, Env } from "../env";
import { ApiError, jsonOk } from "../lib/errors";
import { projectCiObservation } from "../lib/machine-observations";
import { accountReadPlan, savedAccountPolicy } from "../lib/saved-observation-read";
import { latestSnapshotGroups } from "../lib/snapshot-pages";
import { snapshotScope } from "../lib/snapshot-scope";

export async function getCi(c: Context<{ Bindings: Env; Variables: AppVars }>): Promise<Response> {
	const scope = snapshotScope(c.req.queries("scope"));
	const db = c.get("db");
	const plan = accountReadPlan(db, null, "ci", scope);
	const saved = plan.decode(await db.batch(plan.statements));
	const account = saved.account;
	if (!account) throw new ApiError(409, "account_missing", "no active account");
	const policy = savedAccountPolicy(saved, scope);
	return jsonOk(
		{
			...projectCiObservation(policy, latestSnapshotGroups(saved.ciPages)),
			account_id: account.id,
		},
		200,
		{ "cache-control": "private, no-store" },
		c.get("sourceTiming"),
	);
}
