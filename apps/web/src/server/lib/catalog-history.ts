import type {
	CatalogChangeKind,
	CatalogTimestamps,
	CatalogUnconfirmedReason,
} from "../../lib/catalog-types";
import { catalogMutableWrites } from "./catalog-mutable";
import type { Collected } from "./collect";
import type { Db } from "./db/d1";
import { catalogFactory } from "./db/factory-runs";
import { readSnapshot } from "./db/snapshots";
import { ApiError } from "./errors";
import type { GithubClient } from "./github-client";
import { MAX_FETCHES } from "./github-client";
import { GithubUnavailableError } from "./github-unavailable";

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
	name_current?: number;
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
	unconfirmed: (Omit<Event, "kind" | "details"> & { reason: CatalogUnconfirmedReason })[];
	removed: string[];
	removedIdentities: string[];
	displaced: { identity_key: string; repo: string }[];
	restored: { identity_key: string; repo: string }[];
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
		name_current: 1,
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
	for (const row of rows)
		if (row.name_current !== 0 && !row.removed_at)
			row.github_id ??= byName.get(row.repo.toLowerCase()) || null;
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
		unconfirmed: [],
		removed: [],
		removedIdentities: [],
		displaced: [],
		restored: [],
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
				(row) =>
					row.name_current !== 0 && !row.github_id && row.repo.toLowerCase() === name.toLowerCase(),
			) ||
			baseline.rows.find(
				(row) => row.name_current !== 0 && !id && row.repo.toLowerCase() === name.toLowerCase(),
			);
		const row = fromSaved(value, at, id);
		row.first_seen_source = previous?.first_seen_source ?? "github_catalog";
		row.last_source_run_id = source.runId;
		if (previous) {
			matched.add(previous.identity_key);
			row.identity_key = previous.identity_key;
			row.github_id ??= previous.github_id;
			row.first_seen_at = previous.first_seen_at;
			row.archived_changed_at = previous.archived_changed_at;
			if (!previous.removed_at && previous.name_current === 0)
				plan.restored.push({ identity_key: previous.identity_key, repo: name });
			if (previous.removed_at) emit("added", row);
			else {
				if (previous.repo !== name) {
					if (previous.name_current !== 0) plan.renames.push({ from: previous.repo, to: name });
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
		(row) =>
			row.name_current !== 0 &&
			!row.removed_at &&
			row.repo.split("/")[0]?.toLowerCase() === owner.toLowerCase(),
	).length;
	const guarded = missing.length > Math.max(3, ownedBefore * 0.1);
	if (guarded) plan.warning = "catalog_mass_removal_guard";
	const privateProof = plan.rows.some(
		(row) =>
			row.github_id &&
			ids[row.repo.toLowerCase()] === row.github_id &&
			row.visibility === "PRIVATE" &&
			row.repo.split("/")[0]?.toLowerCase() === owner.toLowerCase() &&
			baseline.rows.some(
				(previous) =>
					previous.name_current !== 0 &&
					!previous.removed_at &&
					previous.github_id === row.github_id &&
					previous.visibility === "PRIVATE" &&
					previous.repo.split("/")[0]?.toLowerCase() === owner.toLowerCase(),
			),
	);
	for (const previous of missing) {
		let removed = false;
		let reason: CatalogUnconfirmedReason = guarded
			? "mass_removal_guard"
			: previous.visibility !== "PUBLIC"
				? "private_unverifiable"
				: !privateProof
					? "scope_unverifiable"
					: !previous.github_id
						? "identity_unavailable"
						: gh.count >= MAX_FETCHES
							? "budget_exhausted"
							: "lookup_unverifiable";
		let row = { ...previous };
		if (reason === "lookup_unverifiable") {
			try {
				const data = await gh.githubGraphql(
					token,
					"query CatalogIdentity($id:ID!){node(id:$id){... on Repository{id nameWithOwner}}}",
					{ id: previous.github_id },
				);
				removed =
					gh.graphqlErrors.length > 0 &&
					gh.graphqlErrors.every((error) => error.nodeNotFound === true);
				const node = data.node as { id?: unknown; nameWithOwner?: unknown } | null | undefined;
				if (gh.graphqlErrors.some((error) => error.reasonCode === "permission_denied"))
					reason = "permission_denied";
				if (
					!gh.graphqlErrors.length &&
					node?.id === previous.github_id &&
					typeof node.nameWithOwner === "string" &&
					/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(node.nameWithOwner) &&
					node.nameWithOwner !== previous.repo &&
					!plan.rows.some(
						(current) => current.repo.toLowerCase() === String(node.nameWithOwner).toLowerCase(),
					)
				) {
					row = {
						...previous,
						repo: node.nameWithOwner,
						name_current: 1,
						row_payload: JSON.stringify({
							...JSON.parse(previous.row_payload),
							name_with_owner: node.nameWithOwner,
						}),
						last_source_run_id: source.runId,
					};
					if (previous.name_current === 0)
						plan.restored.push({ identity_key: previous.identity_key, repo: row.repo });
					else plan.renames.push({ from: previous.repo, to: row.repo });
					emit("renamed", row, { previous_repo: previous.repo });
					plan.rows.push(row);
					continue;
				}
			} catch (error) {
				reason =
					error instanceof GithubUnavailableError && error.reasonCode === "permission_denied"
						? "permission_denied"
						: error instanceof ApiError && error.status === 401
							? "github_unauthorized"
							: error instanceof ApiError && error.status === 404
								? "lookup_unverifiable"
								: error instanceof ApiError && error.code === "github_rate_limited"
									? "github_rate_limited"
									: "github_error";
			}
		}
		const replaced = plan.rows.some(
			(current) =>
				current.name_current !== 0 &&
				!current.removed_at &&
				current.repo.toLowerCase() === previous.repo.toLowerCase(),
		);
		row.name_current = replaced || previous.name_current === 0 ? 0 : 1;
		if (removed) {
			if (previous.name_current !== 0) plan.removed.push(previous.repo);
			plan.removedIdentities.push(previous.identity_key);
			row = { ...row, removed_at: at, last_source_run_id: source.runId };
			plan.rows.push(row);
			emit("removed", row);
		} else {
			plan.warning ??= "catalog_removal_unconfirmed";
			plan.unconfirmed.push({
				event_id: crypto.randomUUID(),
				repo: previous.repo,
				github_id: previous.github_id,
				at,
				reason,
			});
			if (replaced && previous.name_current !== 0)
				plan.displaced.push({ identity_key: previous.identity_key, repo: previous.repo });
			plan.rows.push(row);
		}
	}
	const current = plan.rows.filter((row) => !row.removed_at && row.name_current !== 0);
	if (new Set(current.map((row) => row.repo.toLowerCase())).size !== current.length)
		throw new ApiError(409, "catalog_identity_conflict", "Conflicting repository identities");
	if (
		current.filter((row) => row.repo.split("/")[0]?.toLowerCase() === owner.toLowerCase()).length >
		500
	)
		throw new ApiError(422, "catalog_capacity", "Catalog exceeds 500 owned repositories");
	if (plan.rows.filter((row) => !row.removed_at && row.name_current === 0).length > 1000)
		throw new ApiError(
			422,
			"catalog_capacity",
			"Catalog exceeds 1000 unresolved displaced identities",
		);
	return plan;
}
export function catalogSnapshot(plan: CatalogPlan): Collected {
	return {
		truncated: false,
		fetched_at: plan.at,
		repos: plan.rows.filter((row) => !row.removed_at && row.name_current !== 0).map(catalogWireRow),
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
	writes.push(
		db
			.prepare(
				"UPDATE catalog_repositories SET name_current=0 WHERE account_id=? AND identity_key IN (SELECT json_extract(value,'$.identity_key') FROM json_each(?))",
			)
			.bind(account, JSON.stringify(plan.rows)),
	);
	writes.push(
		db
			.prepare(`INSERT INTO catalog_repositories(account_id,identity_key,github_id,repo,row_payload,first_seen_at,last_seen_at,removed_at,archived_changed_at,is_archived,visibility,is_fork,first_seen_source,last_source_run_id,name_current)
 SELECT ?,json_extract(value,'$.identity_key'),json_extract(value,'$.github_id'),json_extract(value,'$.repo'),json_extract(value,'$.row_payload'),json_extract(value,'$.first_seen_at'),json_extract(value,'$.last_seen_at'),json_extract(value,'$.removed_at'),json_extract(value,'$.archived_changed_at'),json_extract(value,'$.is_archived'),json_extract(value,'$.visibility'),json_extract(value,'$.is_fork'),json_extract(value,'$.first_seen_source'),json_extract(value,'$.last_source_run_id'),COALESCE(json_extract(value,'$.name_current'),1) FROM json_each(?) WHERE 1
 ON CONFLICT(account_id,identity_key) DO UPDATE SET github_id=excluded.github_id,repo=excluded.repo,row_payload=excluded.row_payload,first_seen_at=excluded.first_seen_at,last_seen_at=excluded.last_seen_at,removed_at=excluded.removed_at,archived_changed_at=excluded.archived_changed_at,is_archived=excluded.is_archived,visibility=excluded.visibility,is_fork=excluded.is_fork,last_source_run_id=excluded.last_source_run_id,name_current=excluded.name_current`)
			.bind(account, JSON.stringify(plan.rows)),
	);
	writes.push(
		db
			.prepare(`INSERT INTO catalog_unconfirmed(account_id,event_id,repo,github_id,at,source_kind,source_run_id,reason)
 SELECT ?,json_extract(value,'$.event_id'),json_extract(value,'$.repo'),json_extract(value,'$.github_id'),json_extract(value,'$.at'),?,?,json_extract(value,'$.reason') FROM json_each(?)`)
			.bind(account, plan.source.kind, plan.source.runId, JSON.stringify(plan.unconfirmed)),
	);
	writes.push(
		db
			.prepare(`INSERT INTO catalog_changes(account_id,event_id,kind,repo,github_id,at,source_kind,source_run_id,details)
 SELECT ?,json_extract(value,'$.event_id'),json_extract(value,'$.kind'),json_extract(value,'$.repo'),json_extract(value,'$.github_id'),json_extract(value,'$.at'),?,?,json_extract(value,'$.details') FROM json_each(?)`)
			.bind(account, plan.source.kind, plan.source.runId, JSON.stringify(plan.events)),
	);
	writes.push(...catalogMutableWrites(db, account, plan));
	writes.push(...catalogRetentionWrites(db, account, plan.at));
	return writes;
}
export function catalogRetentionWrites(db: Db, account: string, now: string) {
	const cutoff = new Date(Date.parse(now) - 90 * 86400_000).toISOString();
	return [
		db
			.prepare(
				`UPDATE catalog_state SET history_since=MAX(history_since,?,COALESCE((SELECT strftime('%Y-%m-%dT%H:%M:%fZ',at,'+0.001 seconds') FROM (SELECT at,repo,event_id FROM catalog_changes WHERE account_id=? UNION ALL SELECT at,repo,event_id FROM catalog_unconfirmed WHERE account_id=?) ORDER BY at DESC,repo DESC,event_id DESC LIMIT 1 OFFSET 10000),history_since)) WHERE account_id=?`,
			)
			.bind(cutoff, account, account, account),
		db
			.prepare(
				"DELETE FROM catalog_changes WHERE account_id=? AND at<(SELECT history_since FROM catalog_state WHERE account_id=?)",
			)
			.bind(account, account),
		db
			.prepare(
				"DELETE FROM catalog_unconfirmed WHERE account_id=? AND at<(SELECT history_since FROM catalog_state WHERE account_id=?)",
			)
			.bind(account, account),
		db
			.prepare(
				`DELETE FROM catalog_repositories WHERE account_id=? AND removed_at IS NOT NULL AND (removed_at<? OR removed_at<=(SELECT removed_at FROM catalog_repositories WHERE account_id=? AND removed_at IS NOT NULL ORDER BY removed_at DESC,identity_key DESC LIMIT 1 OFFSET 1000))`,
			)
			.bind(account, cutoff, account),
	];
}
