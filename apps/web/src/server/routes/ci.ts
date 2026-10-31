import type { Context } from "hono";
import type { AppVars, Env } from "../env";
import { buildBrowserCi } from "../lib/dashboard-builders";
import { accountObservationDataVersion } from "../lib/dashboard-data-version";
import { dashboardCacheKey, respondDashboardCached } from "../lib/dashboard-response-cache";
import { getActiveAccount } from "../lib/db/accounts";
import { ApiError } from "../lib/errors";
import { snapshotScope } from "../lib/snapshot-scope";

export async function getCi(c: Context<{ Bindings: Env; Variables: AppVars }>): Promise<Response> {
	const scope = snapshotScope(c.req.queries("scope"));
	const db = c.get("db");
	const account = await getActiveAccount(db);
	if (!account) throw new ApiError(409, "account_missing", "no active account");
	return respondDashboardCached(c, {
		accountId: account.id,
		cacheKey: dashboardCacheKey("browser:/api/ci", { scope }),
		machine: false,
		version: () => accountObservationDataVersion(db, account.id, "ci", scope),
		build: () => buildBrowserCi(db, scope),
	});
}
