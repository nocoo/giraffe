import type { CatalogChangeKind, CatalogTimestamps } from "../../lib/catalog-types";
import type { Collected } from "./collect";
import type { Db } from "./db/d1";
import { catalogFactory } from "./db/factory-runs";
import { readSnapshot } from "./db/snapshots";
import { ApiError } from "./errors";
import type { GithubClient } from "./github-client";
import { MAX_FETCHES } from "./github-client";

export type CatalogRow = CatalogTimestamps & {
	identity_key: string;
	github_id: string | null;
	repo: string;
	row_payload: string;
	is_archived: number;
	visibility: string;
	is_fork: number;
	first_seen_source: "saved_catalog" | "github_catalog";
	last_source_run_id: string | null;
};
export type CatalogState = {
	history_since: string;
	checked_at: string | null;
	revision: number;
	source_run_id: string | null;
	warning_code: string | null;
};
type Event = {
	event_id: string;
	kind: CatalogChangeKind;
	repo: string;
	github_id: string | null;
	at: string;
	details: string;
};
export type CatalogPlan = {
	revision: number;
	stateExists: boolean;
	historySince: string;
	at: string;
	rows: CatalogRow[];
	events: Event[];
	removed: string[];
	renames: { from: string; to: string }[];
	warning: string | null;
	complete: boolean;
	source: { kind: "factory" | "legacy"; runId: string | null };
};
const identities = new WeakMap<object, Record<string, string>>();
export function catalogIdentity(payload: object, ids?: Record<string, string>) {
	if (ids) identities.set(payload, ids);
	return identities.get(payload) ?? {};
}
function time(value: unknown): string | null {
	return typeof value === "string" && Number.isFinite(Date.parse(value))
		? new Date(value).toISOString()
		: null;
}
function plain(row: Record<string, unknown>) {
	return Object.fromEntries(
		Object.entries(row).filter(
			([key]) =>
				!["first_seen_at", "last_seen_at", "removed_at", "archived_changed_at"].includes(key),
		),
	);
}
function fromSaved(row: Record<string, unknown>, at: string | null, id: string | null): CatalogRow {
	const repo = String(row.name_with_owner);
	const payload = JSON.stringify(plain(row));
	if (new TextEncoder().encode(payload).length > 16000)
		throw new ApiError(422, "catalog_capacity", "Repository metadata exceeds catalog capacity");
	return {
		identity_key: id ?? `legacy:${repo.toLowerCase()}`,
		github_id: id,
		repo,
		row_payload: payload,
		first_seen_at: at,
		last_seen_at: at,
		removed_at: null,
		archived_changed_at: null,
		is_archived: row.is_archived === true ? 1 : 0,
		visibility: String(row.visibility ?? (row.is_private ? "PRIVATE" : "PUBLIC")),
		is_fork: row.is_fork === true ? 1 : 0,
		first_seen_source: "saved_catalog",
		last_source_run_id: null,
	};
}
export async function beginCatalog(db: Db, account: string) {
	const [stateResult, rowsResult] = await db.batch<CatalogState & CatalogRow>([
		db.prepare("SELECT * FROM catalog_state WHERE account_id=?").bind(account),
		db
			.prepare("SELECT * FROM catalog_repositories WHERE account_id=? ORDER BY repo,identity_key")
			.bind(account),
	]);
	if (!stateResult || !rowsResult) throw new ApiError(500, "db_error", "Incomplete catalog state");
	const saved = await readSnapshot(db, account, "repos");
	const factory = await catalogFactory(db, account);
	const rows = rowsResult.results as CatalogRow[];
	const byName = new Map(factory?.repos.map((repo) => [repo.name.toLowerCase(), repo.id]) ?? []);
	for (const row of rows) row.github_id ??= byName.get(row.repo.toLowerCase()) || null;
	for (const row of Array.isArray(saved?.repos) ? saved.repos : []) {
		if (!row || typeof row.name_with_owner !== "string") continue;
		if (!rows.some((known) => known.repo.toLowerCase() === row.name_with_owner.toLowerCase()))
			rows.push(
				fromSaved(
					row,
					time(saved?.fetched_at),
					byName.get(row.name_with_owner.toLowerCase()) || null,
				),
			);
	}
	return { state: stateResult.results[0] ?? null, rows, saved, factory };
}
export async function planCatalog(
	baseline: Awaited<ReturnType<typeof beginCatalog>>,
	payload: Collected,
	ids: Record<string, string>,
	owner: string,
	gh: GithubClient,
	token: string,
	at: string,
	source: CatalogPlan["source"],
): Promise<CatalogPlan> {
	const plan: CatalogPlan = {
		revision: baseline.state?.revision ?? 0,
		stateExists: baseline.state !== null,
		historySince: baseline.state?.history_since ?? at,
		at,
		rows: [],
		events: [],
		removed: [],
		renames: [],
		warning: null,
		complete:
			payload.truncated !== true &&
			payload.unavailable !== true &&
			payload.forbidden !== true &&
			Array.isArray(payload.repos),
		source,
	};
	if (!plan.complete) {
		plan.warning = "catalog_incomplete";
		return plan;
	}
	if (baseline.state?.checked_at && at <= baseline.state.checked_at)
		throw new ApiError(409, "catalog_conflict", "Catalog completion must follow its predecessor");
	const emit = (kind: CatalogChangeKind, row: CatalogRow, details: object = {}) =>
		plan.events.push({
			event_id: crypto.randomUUID(),
			kind,
			repo: row.repo,
			github_id: row.github_id,
			at,
			details: JSON.stringify(details),
		});
	const matched = new Set<string>();
	for (const value of payload.repos as Record<string, unknown>[]) {
		if (
			typeof value.name_with_owner !== "string" ||
			!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.name_with_owner)
		)
			throw new ApiError(502, "github_error", "Invalid catalog repository");
		const name = value.name_with_owner;
		const id = ids[name.toLowerCase()] ?? null;
		if (!id) plan.warning = "catalog_identity_unavailable";
		const previous =
			(id && baseline.rows.find((row) => row.github_id === id)) ||
			baseline.rows.find(
				(row) => !row.github_id && row.repo.toLowerCase() === name.toLowerCase(),
			) ||
			baseline.rows.find((row) => !id && row.repo.toLowerCase() === name.toLowerCase());
		const row = fromSaved(value, at, id);
		row.first_seen_source = previous?.first_seen_source ?? "github_catalog";
		row.last_source_run_id = source.runId;
		if (previous) {
			matched.add(previous.identity_key);
			row.identity_key = previous.identity_key;
			row.github_id ??= previous.github_id;
			row.first_seen_at = previous.first_seen_at;
			row.archived_changed_at = previous.archived_changed_at;
			if (previous.removed_at) emit("added", row);
			else {
				if (previous.repo !== name) {
					plan.renames.push({ from: previous.repo, to: name });
					emit("renamed", row, { previous_repo: previous.repo });
				}
				if (previous.is_archived !== row.is_archived) {
					row.archived_changed_at = at;
					emit(row.is_archived ? "archived" : "unarchived", row, {
						before: Boolean(previous.is_archived),
						after: Boolean(row.is_archived),
					});
				}
				if (previous.visibility !== row.visibility)
					emit("visibility_changed", row, { before: previous.visibility, after: row.visibility });
				if (previous.is_fork !== row.is_fork)
					emit("fork_changed", row, {
						before: Boolean(previous.is_fork),
						after: Boolean(row.is_fork),
					});
			}
		} else emit("added", row);
		plan.rows.push(row);
	}
	const missing = baseline.rows.filter((row) => !row.removed_at && !matched.has(row.identity_key));
	const ownedBefore = baseline.rows.filter(
		(row) => !row.removed_at && row.repo.split("/")[0]?.toLowerCase() === owner.toLowerCase(),
	).length;
	const guarded = missing.length > Math.max(3, ownedBefore * 0.1);
	if (guarded) plan.warning = "catalog_mass_removal_guard";
	for (const previous of missing) {
		let removed = false;
		if (!guarded && gh.count < MAX_FETCHES) {
			try {
				await gh.githubApi(token, `/repos/${previous.repo}`);
			} catch (error) {
				if (error instanceof ApiError && error.status === 401) throw error;
				removed = error instanceof ApiError && error.status === 404 && error.code === "not_found";
			}
		}
		if (removed) {
			plan.removed.push(previous.repo);
			const row = { ...previous, removed_at: at, last_source_run_id: source.runId };
			plan.rows.push(row);
			emit("removed", row);
		} else {
			plan.warning ??= "catalog_removal_unconfirmed";
			plan.rows.push(previous);
		}
	}
	const current = plan.rows.filter((row) => !row.removed_at);
	if (new Set(current.map((row) => row.repo.toLowerCase())).size !== current.length)
		throw new ApiError(409, "catalog_identity_conflict", "Conflicting repository identities");
	if (
		current.filter((row) => row.repo.split("/")[0]?.toLowerCase() === owner.toLowerCase()).length >
		500
	)
		throw new ApiError(422, "catalog_capacity", "Catalog exceeds 500 owned repositories");
	return plan;
}
export function catalogSnapshot(plan: CatalogPlan): Collected {
	return {
		truncated: false,
		fetched_at: plan.at,
		repos: plan.rows.filter((row) => !row.removed_at).map(catalogWireRow),
	};
}
export function catalogWireRow(row: CatalogRow): Record<string, unknown> {
	return {
		...JSON.parse(row.row_payload),
		first_seen_at: row.first_seen_at,
		last_seen_at: row.last_seen_at,
		removed_at: row.removed_at,
		archived_changed_at: row.archived_changed_at,
	};
}

export function catalogPlanWrites(
	db: Db,
	account: string,
	plan: CatalogPlan,
): D1PreparedStatement[] {
	const writes = [
		db
			.prepare(
				"SELECT CASE WHEN COALESCE((SELECT revision FROM catalog_state WHERE account_id=?),-1)=? THEN 1 ELSE json('{') END",
			)
			.bind(account, plan.stateExists ? plan.revision : -1),
		db
			.prepare(
				"INSERT INTO catalog_state(account_id,history_since,checked_at,revision,source_run_id,warning_code) VALUES(?,?,?,1,?,?) ON CONFLICT(account_id) DO UPDATE SET checked_at=COALESCE(excluded.checked_at,catalog_state.checked_at),revision=catalog_state.revision+1,source_run_id=COALESCE(excluded.source_run_id,catalog_state.source_run_id),warning_code=excluded.warning_code",
			)
			.bind(
				account,
				plan.historySince,
				plan.complete ? plan.at : null,
				plan.source.runId,
				plan.warning,
			),
	];
	if (!plan.complete) return writes;
	// Release row-by-row uniqueness inside the atomic publication before applying rename cycles.
	writes.push(
		db
			.prepare(
				"UPDATE catalog_repositories SET removed_at=? WHERE account_id=? AND removed_at IS NULL AND identity_key IN (SELECT json_extract(value,'$.identity_key') FROM json_each(?))",
			)
			.bind(plan.at, account, JSON.stringify(plan.rows)),
	);
	writes.push(
		db
			.prepare(`INSERT INTO catalog_repositories(account_id,identity_key,github_id,repo,row_payload,first_seen_at,last_seen_at,removed_at,archived_changed_at,is_archived,visibility,is_fork,first_seen_source,last_source_run_id)
 SELECT ?,json_extract(value,'$.identity_key'),json_extract(value,'$.github_id'),json_extract(value,'$.repo'),json_extract(value,'$.row_payload'),json_extract(value,'$.first_seen_at'),json_extract(value,'$.last_seen_at'),json_extract(value,'$.removed_at'),json_extract(value,'$.archived_changed_at'),json_extract(value,'$.is_archived'),json_extract(value,'$.visibility'),json_extract(value,'$.is_fork'),json_extract(value,'$.first_seen_source'),json_extract(value,'$.last_source_run_id') FROM json_each(?) WHERE 1
 ON CONFLICT(account_id,identity_key) DO UPDATE SET github_id=excluded.github_id,repo=excluded.repo,row_payload=excluded.row_payload,first_seen_at=excluded.first_seen_at,last_seen_at=excluded.last_seen_at,removed_at=excluded.removed_at,archived_changed_at=excluded.archived_changed_at,is_archived=excluded.is_archived,visibility=excluded.visibility,is_fork=excluded.is_fork,last_source_run_id=excluded.last_source_run_id`)
			.bind(account, JSON.stringify(plan.rows)),
	);
	writes.push(
		db
			.prepare(`INSERT INTO catalog_changes(account_id,event_id,kind,repo,github_id,at,source_kind,source_run_id,details)
 SELECT ?,json_extract(value,'$.event_id'),json_extract(value,'$.kind'),json_extract(value,'$.repo'),json_extract(value,'$.github_id'),json_extract(value,'$.at'),?,?,json_extract(value,'$.details') FROM json_each(?)`)
			.bind(account, plan.source.kind, plan.source.runId, JSON.stringify(plan.events)),
	);
	for (const table of ["repo_stars", "repo_statistics", "factory_repo_state"])
		writes.push(
			db
				.prepare(
					`DELETE FROM ${table} WHERE account_id=? AND repo COLLATE NOCASE IN (SELECT value FROM json_each(?))`,
				)
				.bind(account, JSON.stringify(plan.removed)),
		);
	const nonce = crypto.randomUUID();
	const renames = JSON.stringify(
		plan.renames.map((rename, index) => ({ ...rename, staged: `@catalog:${nonce}:${index}` })),
	);
	for (const table of ["repo_stars", "repo_statistics", "factory_repo_state"]) {
		const mapping =
			"(SELECT json_extract(value,'$.to') FROM json_each(?) WHERE lower(json_extract(value,'$.from'))=lower(repo))";
		const staged =
			"(SELECT json_extract(value,'$.staged') FROM json_each(?) WHERE lower(json_extract(value,'$.from'))=lower(repo))";
		writes.push(
			db
				.prepare(
					`UPDATE ${table} SET ${table === "factory_repo_state" ? `payload=CASE WHEN json_type(payload,'$.observation')='object' THEN json_set(payload,'$.repo',${mapping},'$.observation.repo',COALESCE(json_extract(payload,'$.observation.repo'),repo)) ELSE json_set(payload,'$.repo',${mapping}) END,` : ""}repo=${staged} WHERE account_id=? AND repo COLLATE NOCASE IN (SELECT json_extract(value,'$.from') FROM json_each(?))`,
				)
				.bind(
					...(table === "factory_repo_state" ? [renames, renames] : []),
					renames,
					account,
					renames,
				),
			db
				.prepare(
					`UPDATE ${table} SET repo=(SELECT json_extract(value,'$.to') FROM json_each(?) WHERE json_extract(value,'$.staged')=repo) WHERE account_id=? AND repo IN (SELECT json_extract(value,'$.staged') FROM json_each(?))`,
				)
				.bind(renames, account, renames),
		);
	}
	writes.push(...catalogRetentionWrites(db, account, plan.at));
	return writes;
}
export function catalogRetentionWrites(db: Db, account: string, now: string) {
	const cutoff = new Date(Date.parse(now) - 90 * 86400_000).toISOString();
	return [
		db
			.prepare(
				`UPDATE catalog_state SET history_since=MAX(history_since,?,COALESCE((SELECT strftime('%Y-%m-%dT%H:%M:%fZ',at,'+0.001 seconds') FROM catalog_changes WHERE account_id=? ORDER BY at DESC,repo DESC,event_id DESC LIMIT 1 OFFSET 10000),history_since)) WHERE account_id=?`,
			)
			.bind(cutoff, account, account),
		db
			.prepare(
				"DELETE FROM catalog_changes WHERE account_id=? AND at<(SELECT history_since FROM catalog_state WHERE account_id=?)",
			)
			.bind(account, account),
		db
			.prepare(
				`DELETE FROM catalog_repositories WHERE account_id=? AND removed_at IS NOT NULL AND (removed_at<? OR removed_at<=(SELECT removed_at FROM catalog_repositories WHERE account_id=? AND removed_at IS NOT NULL ORDER BY removed_at DESC,identity_key DESC LIMIT 1 OFFSET 1000))`,
			)
			.bind(account, cutoff, account),
	];
}
