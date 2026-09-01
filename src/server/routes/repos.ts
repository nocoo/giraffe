import type { Context } from "hono";
import type { AppVars, Env } from "../env";
import { repoParts, snapshotGet } from "./snapshots";

export function repoGet(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
	suffix: string,
): Promise<Response> {
	const { owner, name } = repoParts(String(c.req.param("owner")), String(c.req.param("name")));
	return snapshotGet(c, `repo:${owner}/${name}:${suffix}`);
}
