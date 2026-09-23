import type { Context } from "hono";
import { z } from "zod";
import type { AppVars, Env } from "../env";
import { getActiveAccount } from "../lib/db/accounts";
import { ApiError, jsonOk } from "../lib/errors";
import { ACCOUNT_ID_RE } from "../lib/id";
import { readJson } from "../lib/read-body";
import { repoPolicy } from "../lib/repo-statistics";
import { repoParts, snapshotGet } from "./snapshots";

const settingsInput = z
	.object({ account_id: z.string().regex(ACCOUNT_ID_RE), enabled: z.boolean() })
	.strict();
export async function setRepoStatistics(
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
	const policy = await repoPolicy(db, account.id);
	const full = `${owner}/${name}`;
	const repo = policy.repos.find((r) => r.name_with_owner.toLowerCase() === full.toLowerCase());
	if (!repo) throw new ApiError(404, "not_found", "repository not in catalog");
	await db
		.prepare(
			"INSERT INTO repo_statistics(account_id,repo,enabled) VALUES(?,?,?) ON CONFLICT(account_id,repo) DO UPDATE SET enabled=excluded.enabled",
		)
		.bind(account.id, repo.name_with_owner, Number(parsed.data.enabled))
		.run();
	return jsonOk({
		account_id: account.id,
		name_with_owner: repo.name_with_owner,
		statistics_enabled: parsed.data.enabled,
	});
}

export function repoGet(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
	suffix: string,
): Promise<Response> {
	const { owner, name } = repoParts(String(c.req.param("owner")), String(c.req.param("name")));
	return snapshotGet(c, `repo:${owner}/${name}:${suffix}`);
}
