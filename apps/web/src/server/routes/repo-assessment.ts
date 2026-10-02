import type { Context } from "hono";
import { snapshotFreshness } from "../../lib/snapshot-freshness";
import type { AppVars, Env } from "../env";
import { readAssessment } from "../lib/ai-assessment";
import { assessmentDigests } from "../lib/assessment-digest";
import { getActiveAccount } from "../lib/db/accounts";
import { readSnapshot } from "../lib/db/snapshots";
import { ApiError, jsonOk } from "../lib/errors";
import { repoPolicy } from "../lib/repo-statistics";
import { snapshotScope } from "../lib/snapshot-scope";
import { repoParts } from "./snapshots";

export async function getRepoAssessment(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
): Promise<Response> {
	snapshotScope(c.req.queries("scope"));
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
	const scope = snapshotScope(c.req.queries("scope"));
	const db = c.get("db");
	const account = await getActiveAccount(db);
	if (!account) throw new ApiError(409, "account_missing", "No active account");
	const catalog = await readSnapshot(db, account.id, "repos");
	const policy = await repoPolicy(db, account.id, catalog, scope);
	if (!catalog && !policy.empty)
		throw new ApiError(409, "snapshot_missing", "no repository catalog");
	const digests = await assessmentDigests(db, account.id, policy);
	const reportTimes = new Map(
		digests.items.map((item) => [item.repo.toLowerCase(), item.reportAt]),
	);
	const freshness = snapshotFreshness(
		policy.repos
			.filter((repo) => policy.enabled(repo.name_with_owner))
			.map((repo) => reportTimes.get(repo.name_with_owner.toLowerCase())),
	);
	return jsonOk(
		{
			account_id: account.id,
			fetched_at: freshness.latestAt ?? "",
			freshness,
			truncated: catalog?.truncated === true,
			...digests,
		},
		200,
		{ "cache-control": "private, no-store" },
	);
}
