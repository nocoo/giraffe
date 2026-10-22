import type { Context, Next } from "hono";
import { etag } from "hono/etag";
import type { AppVars, Env } from "../env";
import { ApiError } from "../lib/errors";
import { readGithubDailyHistory, readLatestReport } from "../lib/report-latest";

type Ctx = Context<{ Bindings: Env; Variables: AppVars }>;
const conditional = etag({
	weak: false,
	generateDigest: (body) => crypto.subtle.digest("SHA-256", body),
});
export async function reportLatestHeaders(context: Ctx, next: Next) {
	await next();
	context.header("Cache-Control", "private, no-store");
	context.header("Referrer-Policy", "no-referrer");
	context.header(
		"Vary",
		context.req.path.startsWith("/api/v1/") ? "Authorization" : "Cookie, Cf-Access-Jwt-Assertion",
	);
}
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
export async function dailyReportHistory(context: Ctx) {
	if (context.req.method !== "GET")
		throw new ApiError(405, "method_not_allowed", "Daily history is read-only");
	if (Object.keys(context.req.queries()).length)
		throw new ApiError(400, "validation_failed", "Unexpected query parameters");
	return context.json(
		await readGithubDailyHistory(context.get("db"), context.req.param("account") ?? ""),
	);
}
