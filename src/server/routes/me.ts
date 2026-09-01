import type { Context } from "hono";
import type { AppVars, Env } from "../env";

export function getMe(c: Context<{ Bindings: Env; Variables: AppVars }>): Response {
	return c.json(c.get("identity"));
}
