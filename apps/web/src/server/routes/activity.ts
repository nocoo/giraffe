import type { Context } from "hono";
import type { AppVars, Env } from "../env";
import { respondActivityDashboardCached } from "../lib/dashboard-response-cache";
import { getActiveAccount } from "../lib/db/accounts";
import { ApiError } from "../lib/errors";

type Ctx = Context<{ Bindings: Env; Variables: AppVars }>;

function activityQueryKey(query: Record<string, string[]>): string {
	return Object.entries(query)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.flatMap(([key, values]) => values.map((value) => `${key}=${value}`))
		.join("&");
}

export async function activityHeaders(c: Ctx, next: () => Promise<void>) {
	await next();
	if (c.res.status >= 400) {
		c.header("Cache-Control", "private, no-store");
		c.header("Referrer-Policy", "no-referrer");
		c.header(
			"Vary",
			c.req.path.startsWith("/api/v1/") ? "Authorization" : "Cookie, Cf-Access-Jwt-Assertion",
		);
	}
}

export async function getActivity(c: Ctx) {
	const machine = c.req.path.startsWith("/api/v1/");
	const accountId = machine ? c.req.param("account") : (await getActiveAccount(c.get("db")))?.id;
	if (!accountId) throw new ApiError(409, "account_missing", "No active account");
	const query = c.req.queries();
	return respondActivityDashboardCached(c, {
		accountId,
		query,
		queryKey: activityQueryKey(query),
		machine,
	});
}
