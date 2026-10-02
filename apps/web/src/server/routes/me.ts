import type { Context } from "hono";
import type { AppVars, Env } from "../env";
import { fetchAuthorProfile } from "../lib/author-profile";

export async function getMe(c: Context<{ Bindings: Env; Variables: AppVars }>): Promise<Response> {
	const identity = c.get("identity");
	const profile = await fetchAuthorProfile(identity.email);
	return c.json({
		email: identity.email,
		name: profile.name ?? identity.name,
		avatar: profile.avatar,
	});
}
