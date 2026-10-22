import type { Context } from "hono";
import { z } from "zod";
import type { AppVars, Env } from "../env";
import { getActiveAccount } from "../lib/db/accounts";
import { ApiError, jsonOk } from "../lib/errors";
import { ACCOUNT_ID_RE } from "../lib/id";
import { requireCatalogRepo } from "../lib/machine-observations";
import { readJson } from "../lib/read-body";
import { enableDefaultSchedules } from "../lib/refresh-schedule";
import { repoParts, snapshotGet } from "./snapshots";

const settingsInput = z
	.object({ account_id: z.string().regex(ACCOUNT_ID_RE), enabled: z.boolean() })
	.strict();
export function setRepoStatistics(): never {
	throw new ApiError(410, "deprecated", "statistics settings are replaced by stars");
}
export async function setRepoStar(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
): Promise<Response> {
	const { owner, name } = repoParts(String(c.req.param("owner")), String(c.req.param("name")));
	const parsed = settingsInput.safeParse(await readJson(c.req.raw, 1024));
	if (!parsed.success) throw new ApiError(400, "validation_failed", "invalid repository settings");
	const db = c.get("db");
	const account = await getActiveAccount(db);
	if (!account) throw new ApiError(409, "account_missing", "no active account");
	if (account.id !== parsed.data.account_id)
		throw new ApiError(409, "account_conflict", "account changed");
	const repo = await requireCatalogRepo(db, account.id, `${owner}/${name}`);
	if (parsed.data.enabled) {
		await db
			.prepare(
				"INSERT INTO repo_stars(account_id,repo) VALUES(?,?) ON CONFLICT(account_id,repo) DO NOTHING",
			)
			.bind(account.id, repo)
			.run();
		await enableDefaultSchedules(db, account.id, new Date().toISOString());
	} else
		await db
			.prepare("DELETE FROM repo_stars WHERE account_id=? AND repo=?")
			.bind(account.id, repo)
			.run();
	return jsonOk({
		account_id: account.id,
		name_with_owner: repo,
		starred: parsed.data.enabled,
	});
}

export function repoGet(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
	suffix: string,
): Promise<Response> {
	const { owner, name } = repoParts(String(c.req.param("owner")), String(c.req.param("name")));
	return snapshotGet(c, `repo:${owner}/${name}:${suffix}`);
}
