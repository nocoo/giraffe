import type { Context } from "hono";
import { z } from "zod";
import type { AppVars, Env } from "../env";
import { getActiveAccount } from "../lib/db/accounts";
import { ApiError, jsonOk } from "../lib/errors";
import { ACCOUNT_ID_RE } from "../lib/id";
import { requireCatalogRepo } from "../lib/machine-observations";
import { readJson } from "../lib/read-body";
import { enableDefaultSchedules } from "../lib/refresh-schedule";
import { starReason, writeStar } from "../lib/repo-stars";
import { repoParts, snapshotGet } from "./snapshots";

const settingsInput = z
	.object({ account_id: z.string().regex(ACCOUNT_ID_RE), enabled: z.boolean(), reason: starReason })
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
	const now = new Date().toISOString();
	const { item } = await writeStar(
		db,
		account.id,
		repo,
		parsed.data.enabled,
		"owner",
		parsed.data.reason ?? null,
		now,
	);
	if (item.starred) await enableDefaultSchedules(db, account.id, now);
	return jsonOk({
		account_id: account.id,
		name_with_owner: repo,
		starred: item.starred,
		star_source: item.source,
		star_updated_at: item.updated_at,
	});
}

export function repoGet(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
	suffix: string,
): Promise<Response> {
	const { owner, name } = repoParts(String(c.req.param("owner")), String(c.req.param("name")));
	return snapshotGet(c, `repo:${owner}/${name}:${suffix}`);
}
