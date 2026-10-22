import type { Context } from "hono";
import type { AppVars, Env } from "../env";
import { catalogInclude } from "../lib/catalog-read";
import { getActiveAccount } from "../lib/db/accounts";
import { readRepositorySnapshot, readSnapshot, snapshotFromRows } from "../lib/db/snapshots";
import { ApiError, jsonOk } from "../lib/errors";
import { enrichRepoAgentStates } from "../lib/repo-agent-state";
import { accountReadPlan, savedAccountPolicy } from "../lib/saved-observation-read";
import { assembleSnapshotGroups } from "../lib/snapshot-pages";
import { projectSnapshot, repoPolicy, scopedSnapshot } from "../lib/snapshot-projection";
import { snapshotScope } from "../lib/snapshot-scope";

export async function snapshotGet(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
	logical: string,
): Promise<Response> {
	const scope = snapshotScope(c.req.queries("scope"));
	const includeRemoved = logical === "repos" ? catalogInclude(c.req.queries()) : false;
	if (logical === "repos" || logical === "issues" || logical === "prs") {
		const db = c.get("db");
		const plan = accountReadPlan(db, null, logical, scope);
		const saved = plan.decode(await db.batch(plan.statements));
		if (!saved.account) throw new ApiError(409, "account_missing", "no active account");
		let snap = snapshotFromRows(logical, saved.sourcePages);
		if (!snap && scope === "all")
			throw new ApiError(409, "snapshot_missing", `no snapshot for ${logical}`);
		let policy =
			logical === "repos"
				? savedAccountPolicy(saved, scope, snap, includeRemoved)
				: savedAccountPolicy(saved, scope);
		if (!snap && policy.empty) {
			const key = { repos: "repos", issues: "issues", prs: "pull_requests" }[logical];
			snap = { [key]: [], fetched_at: "", truncated: false };
			if (logical === "repos") policy = { ...policy, catalog: snap };
		}
		if (!snap) throw new ApiError(409, "snapshot_missing", `no snapshot for ${logical}`);
		let projected = await projectSnapshot(db, saved.account.id, logical, snap, policy, () =>
			assembleSnapshotGroups(saved.repositoryPages),
		);
		if (logical === "repos")
			projected = await enrichRepoAgentStates(db, saved.account.id, projected);
		return jsonOk(
			{
				...projected,
				account_id: saved.account.id,
			},
			200,
			{ "cache-control": "private, no-store" },
			c.get("sourceTiming"),
		);
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
		{ "cache-control": "private, no-store" },
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
