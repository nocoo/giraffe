import type { Context } from "hono";
import { type CiEntry, type CiRelease, type CiRun, ciReport } from "../../lib/ci-health";
import { snapshotFreshness } from "../../lib/snapshot-freshness";
import type { AppVars, Env } from "../env";
import { getActiveAccount } from "../lib/db/accounts";
import { ApiError, jsonOk } from "../lib/errors";
import { repoPolicy } from "../lib/repo-statistics";
import { assemblePages, type SnapshotPage } from "../lib/snapshot-pages";
import { snapshotScope } from "../lib/snapshot-scope";

const KIND = /^repo:(.+):(actions|releases|details)(?:#2)?$/;

/** Read-only report over saved per-repository Actions and Release snapshots. */
export async function getCi(c: Context<{ Bindings: Env; Variables: AppVars }>): Promise<Response> {
	const scope = snapshotScope(c.req.queries("scope"));
	const db = c.get("db");
	const account = await getActiveAccount(db);
	if (!account) throw new ApiError(409, "account_missing", "no active account");
	const policy = await repoPolicy(db, account.id, undefined, scope);
	if (!policy.catalog && !policy.empty)
		throw new ApiError(409, "snapshot_missing", "no repository catalog");
	// One statement for every repository keeps the Worker well inside the D1 statement cap.
	const rows = await db
		.prepare(
			"SELECT kind, payload, fetched_at FROM snapshots WHERE account_id=? AND kind LIKE 'repo:%' AND (kind LIKE '%:actions' OR kind LIKE '%:actions#2' OR kind LIKE '%:releases' OR kind LIKE '%:releases#2' OR kind LIKE '%:details')",
		)
		.bind(account.id)
		.all<SnapshotPage & { fetched_at: string }>();
	const groups = new Map<string, Map<string, SnapshotPage[]>>();
	for (const row of rows.results) {
		// The SQL filter guarantees the repo:<name>:<suffix> shape.
		const [, repo, suffix] = KIND.exec(row.kind) as RegExpExecArray;
		const byKind = groups.get(String(repo).toLowerCase()) ?? new Map<string, SnapshotPage[]>();
		const logical = `repo:${repo}:${suffix}`;
		byKind.set(logical, [...(byKind.get(logical) ?? []), row]);
		groups.set(String(repo).toLowerCase(), byKind);
	}
	const entries: CiEntry[] = [];
	const unsaved: string[] = [];
	const times: (string | null)[] = [];
	for (const repo of policy.repos) {
		const name = repo.name_with_owner;
		if (!policy.enabled(name)) continue;
		const pages = groups.get(name.toLowerCase());
		const read = (suffix: string) => {
			const found = [...(pages ?? [])].find(
				([k]) => k.toLowerCase() === `repo:${name}:${suffix}`.toLowerCase(),
			);
			return found ? assemblePages(found[0], found[1]) : null;
		};
		const actions = read("actions");
		const releases = read("releases");
		const details = read("details");
		const dependencies = [actions, releases, details].map((snapshot) =>
			snapshot?.unavailable !== true &&
			snapshot?.forbidden !== true &&
			typeof snapshot?.fetched_at === "string"
				? snapshot.fetched_at
				: null,
		);
		times.push(...dependencies);
		if (!actions || actions.unavailable === true || actions.forbidden === true) {
			unsaved.push(name);
			continue;
		}
		entries.push({
			repo: name,
			fetched_at: snapshotFreshness(dependencies).latestAt ?? "",
			truncated: actions.truncated === true,
			runs: Array.isArray(actions.runs) ? (actions.runs as CiRun[]) : [],
			...(typeof details?.default_branch === "string"
				? { default_branch: details.default_branch }
				: {}),
			releases: Array.isArray(releases?.releases) ? (releases.releases as CiRelease[]) : null,
		});
	}
	const freshness = snapshotFreshness(times);
	const fetchedAt = freshness.latestAt ?? "";
	const report = ciReport(entries, fetchedAt || "1970-01-01T00:00:00.000Z");
	return jsonOk(
		{
			...report,
			daily: fetchedAt ? report.daily : [],
			account_id: account.id,
			fetched_at: fetchedAt,
			freshness,
			truncated: entries.some((e) => e.truncated),
			now: fetchedAt,
			unsaved,
		},
		200,
		{ "cache-control": "private, no-store" },
	);
}
