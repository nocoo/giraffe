import type { Context } from "hono";
import { type CiEntry, type CiRelease, type CiRun, ciReport } from "../../lib/ci-health";
import type { AppVars, Env } from "../env";
import { getActiveAccount } from "../lib/db/accounts";
import { ApiError, jsonOk } from "../lib/errors";
import { repoPolicy } from "../lib/repo-statistics";
import { assemblePages, type SnapshotPage } from "../lib/snapshot-pages";

const KIND = /^repo:(.+):(actions|releases|details)(?:#2)?$/;

/** Read-only report over saved per-repository Actions and Release snapshots. */
export async function getCi(c: Context<{ Bindings: Env; Variables: AppVars }>): Promise<Response> {
	const db = c.get("db");
	const account = await getActiveAccount(db);
	if (!account) throw new ApiError(409, "account_missing", "no active account");
	const policy = await repoPolicy(db, account.id);
	if (!policy.repos.length) throw new ApiError(409, "snapshot_missing", "no repository catalog");
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
		if (!actions) {
			unsaved.push(name);
			continue;
		}
		const releases = read("releases");
		const details = read("details");
		entries.push({
			repo: name,
			fetched_at: String(actions.fetched_at ?? ""),
			truncated: actions.truncated === true,
			runs: Array.isArray(actions.runs) ? (actions.runs as CiRun[]) : [],
			...(typeof details?.default_branch === "string"
				? { default_branch: details.default_branch }
				: {}),
			releases: Array.isArray(releases?.releases) ? (releases.releases as CiRelease[]) : null,
		});
	}
	// Judge against the newest saved run time, not the request clock: GET never refreshes data.
	const fetchedAt =
		entries
			.map((e) => e.fetched_at)
			.sort()
			.at(-1) ?? "";
	const now = fetchedAt || new Date().toISOString();
	return jsonOk(
		{
			...ciReport(entries, now),
			account_id: account.id,
			fetched_at: fetchedAt,
			truncated: entries.some((e) => e.truncated),
			now,
			unsaved,
		},
		200,
		{ "cache-control": "private, no-store" },
	);
}
