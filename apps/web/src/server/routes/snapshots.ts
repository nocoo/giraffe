import type { Context } from "hono";
import type { AppVars, Env } from "../env";
import { catalogInclude } from "../lib/catalog-read";
import { buildBrowserAccountSnapshot, patchBrowserReposBody } from "../lib/dashboard-builders";
import { accountObservationDataVersion } from "../lib/dashboard-data-version";
import { dashboardCacheKey, respondDashboardCached } from "../lib/dashboard-response-cache";
import { getActiveAccount } from "../lib/db/accounts";
import { readRepositorySnapshot, readSnapshot } from "../lib/db/snapshots";
import { ApiError, jsonOk } from "../lib/errors";
import type { AccountObservationResource } from "../lib/saved-observation-statements";
import { repoPolicy, scopedSnapshot } from "../lib/snapshot-projection";
import { snapshotScope } from "../lib/snapshot-scope";

export async function snapshotGet(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
	logical: string,
): Promise<Response> {
	const scope = snapshotScope(c.req.queries("scope"));
	const includeRemoved = logical === "repos" ? catalogInclude(c.req.queries()) : false;
	if (logical === "repos" || logical === "issues" || logical === "prs") {
		const db = c.get("db");
		const account = await getActiveAccount(db);
		if (!account) throw new ApiError(409, "account_missing", "no active account");
		return respondDashboardCached(c, {
			accountId: account.id,
			cacheKey: dashboardCacheKey(`browser:/api/${logical}`, {
				scope,
				...(logical === "repos" ? { includeRemoved: includeRemoved ? "1" : "0" } : {}),
			}),
			machine: false,
			version: () =>
				accountObservationDataVersion(
					db,
					account.id,
					logical as AccountObservationResource,
					scope,
					includeRemoved,
				),
			build: () =>
				buildBrowserAccountSnapshot(
					db,
					logical as "repos" | "issues" | "prs",
					scope,
					includeRemoved,
				),
			...(logical === "repos"
				? {
						patch: (stored: unknown) =>
							patchBrowserReposBody(db, account.id, stored as Record<string, unknown>),
					}
				: {}),
		});
	}
	const account = await getActiveAccount(c.get("db"));
	if (!account) {
		throw new ApiError(409, "account_missing", "no active account");
	}
	let snap = logical.startsWith("repo:")
		? ((await readRepositorySnapshot(c.get("db"), account.id, logical))?.data ?? null)
		: await readSnapshot(c.get("db"), account.id, logical);
	if (!snap && scope === "starred" && !logical.startsWith("repo:")) {
		const selection = await repoPolicy(c.get("db"), account.id, undefined, scope);
		const key = (
			{
				repos: "repos",
				issues: "issues",
				prs: "pull_requests",
				alerts: "items",
				notifications: "notifications",
				insights: "insights",
			} as Record<string, string>
		)[logical];
		if (selection.empty && key) snap = { [key]: [], fetched_at: "", truncated: false };
	}
	if (!snap) {
		throw new ApiError(409, "snapshot_missing", `no snapshot for ${logical}`);
	}
	return jsonOk(
		{
			...(await scopedSnapshot(c.get("db"), account.id, logical, snap, scope)),
			account_id: account.id,
		},
		200,
		{ "cache-control": "private, no-cache" },
		c.get("sourceTiming"),
	);
}

export function repoParts(owner: string, name: string): { owner: string; name: string } {
	const ok = /^[A-Za-z0-9_.-]+$/;
	if (
		!ok.test(owner) ||
		!ok.test(name) ||
		owner === "." ||
		owner === ".." ||
		name === "." ||
		name === ".."
	) {
		throw new ApiError(400, "validation_failed", "invalid repo");
	}
	return { owner, name };
}
