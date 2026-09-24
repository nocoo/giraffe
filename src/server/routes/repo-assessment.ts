import type { Context } from "hono";
import type { AppVars, Env } from "../env";
import { readAssessment } from "../lib/ai-assessment";
import { assessmentDigests } from "../lib/assessment-digest";
import { getActiveAccount } from "../lib/db/accounts";
import { readSnapshot } from "../lib/db/snapshots";
import { ApiError, jsonOk } from "../lib/errors";
import { repoPolicy } from "../lib/repo-statistics";
import { repoParts } from "./snapshots";

export async function getRepoAssessment(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
): Promise<Response> {
	const db = c.get("db");
	const account = await getActiveAccount(db);
	if (!account) throw new ApiError(409, "account_missing", "No active account");
	const { owner, name } = repoParts(c.req.param("owner") ?? "", c.req.param("name") ?? "");
	const snapshot = (await readSnapshot(db, account.id, "repos")) as {
		repos?: { name_with_owner: string }[];
	} | null;
	const repo = snapshot?.repos?.find(
		(item) => item.name_with_owner.toLowerCase() === `${owner}/${name}`.toLowerCase(),
	);
	if (!repo) throw new ApiError(404, "not_found", "Repository outside account inventory");
	return jsonOk(await readAssessment(db, account.id, repo.name_with_owner), 200, {
		"cache-control": "private, no-store",
	});
}

/** Saved assessments for every participating repository; read-only, no provider calls. */
export async function getAssessmentDigests(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
): Promise<Response> {
	const db = c.get("db");
	const account = await getActiveAccount(db);
	if (!account) throw new ApiError(409, "account_missing", "No active account");
	const catalog = await readSnapshot(db, account.id, "repos");
	const policy = await repoPolicy(db, account.id, catalog);
	if (!catalog || !policy.repos.length)
		throw new ApiError(409, "snapshot_missing", "no repository catalog");
	return jsonOk(
		{
			account_id: account.id,
			fetched_at: String(catalog.fetched_at ?? ""),
			truncated: catalog.truncated === true,
			...(await assessmentDigests(db, account.id, policy)),
		},
		200,
		{ "cache-control": "private, no-store" },
	);
}
