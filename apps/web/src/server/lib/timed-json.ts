import type { Context } from "hono";
import type { AppVars, Env } from "../env";

export function timedJson<Variables extends AppVars>(
	context: Context<{ Bindings: Env; Variables: Variables }>,
	value: unknown,
) {
	const timing = context.get("sourceTiming");
	return context.body(timing ? timing.stringify(value) : JSON.stringify(value), 200, {
		"Content-Type": "application/json",
	});
}
