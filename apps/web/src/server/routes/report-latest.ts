import type { Context, Next } from "hono";
import { etag } from "hono/etag";
import type { AppVars, Env } from "../env";
import { readLatestReport } from "../lib/report-latest";

type Ctx = Context<{ Bindings: Env; Variables: AppVars }>;
const conditional = etag({
	weak: false,
	generateDigest: (body) => crypto.subtle.digest("SHA-256", body),
});
export async function latestReport(context: Ctx, next: Next) {
	if (context.req.method !== "GET") return next();
	if (!("type" in context.req.queries())) return next();
	await conditional(context, async () => {
		context.res = context.json(
			await readLatestReport(
				context.get("db"),
				context.req.param("account") ?? "",
				context.req.queries(),
			),
		);
	});
	return context.res;
}
