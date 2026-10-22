import type { Context, Next } from "hono";
import { etag, RETAINED_304_HEADERS } from "hono/etag";
import type { AppVars, Env } from "../env";
import { readActivity } from "../lib/activity-store";
import { getActiveAccount } from "../lib/db/accounts";
import { ApiError } from "../lib/errors";

type Ctx = Context<{ Bindings: Env; Variables: AppVars }>;
const conditionalActivity = etag({
	weak: false,
	retainedHeaders: [...RETAINED_304_HEADERS, "referrer-policy"],
});
export async function activityEtag(c: Ctx, next: Next) {
	await conditionalActivity(c, next);
	c.header("Cache-Control", "private, no-store");
	c.header("Referrer-Policy", "no-referrer");
	c.header(
		"Vary",
		c.req.path.startsWith("/api/v1/") ? "Authorization" : "Cookie, Cf-Access-Jwt-Assertion",
	);
}
export async function getActivity(c: Ctx) {
	const account = await getActiveAccount(c.get("db"));
	if (!account) throw new ApiError(409, "account_missing", "No active account");
	return c.json(await readActivity(c.get("db"), account.id, c.req.queries()));
}
