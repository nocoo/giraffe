import { z } from "zod";
import type {
	CatalogChange,
	CatalogChangeKind,
	CatalogChanges,
	CatalogUnconfirmedReason,
} from "../../lib/catalog-types";
import type { FactoryRepo } from "../../lib/factory-types";
import { type CatalogRow, type CatalogState, catalogWireRow } from "./catalog-history";
import { identifyCatalogRow } from "./catalog-identity";
import { storedContent, withContent } from "./content-version";
import type { Db } from "./db/d1";
import { ApiError } from "./errors";

export function catalogFactoryRepo<Repo extends Pick<FactoryRepo, "id" | "name" | "observation">>(
	repo: Repo,
	rows: CatalogRow[],
): Repo | null {
	const current = rows.find(
		(row) => row.github_id === repo.id && !row.removed_at && row.name_current !== 0,
	);
	if (!current) {
		const named = rows.find(
			(row) =>
				row.repo.toLowerCase() === repo.name.toLowerCase() &&
				!row.removed_at &&
				row.name_current !== 0,
		);
		return named?.github_id ? null : repo;
	}
	if (current.repo === repo.name) return repo;
	return {
		...repo,
		name: current.repo,
		...(repo.observation
			? { observation: { ...repo.observation, repo: repo.observation.repo ?? repo.name } }
			: {}),
	};
}

export function catalogInclude(query: Record<string, string[]>) {
	for (const [key, values] of Object.entries(query))
		if (!["scope", "include"].includes(key) || values.length !== 1)
			throw new ApiError(400, "validation_failed", "Invalid repository filters");
	if (query.include && query.include[0] !== "removed")
		throw new ApiError(400, "validation_failed", "Invalid repository inclusion");
	return query.include?.[0] === "removed";
}
export function catalogView(
	snapshot: Record<string, unknown> | null,
	rows: CatalogRow[],
	includeRemoved = false,
) {
	if (!snapshot || !Array.isArray(snapshot.repos)) return snapshot;
	const current = snapshot.repos.flatMap((value) => {
		if (!value || typeof value !== "object" || typeof value.name_with_owner !== "string")
			return [value];
		const row = rows.find(
			(row) =>
				row.repo.toLowerCase() === String(value.name_with_owner).toLowerCase() &&
				!row.removed_at &&
				row.name_current !== 0,
		);
		if (
			!row &&
			rows.some(
				(row) =>
					row.repo.toLowerCase() === String(value.name_with_owner).toLowerCase() &&
					(row.removed_at || row.name_current === 0),
			)
		)
			return [];
		return [
			identifyCatalogRow(
				{
					...value,
					first_seen_at: row?.first_seen_at ?? value.first_seen_at ?? null,
					last_seen_at: row?.last_seen_at ?? value.last_seen_at ?? null,
					removed_at: null,
					archived_changed_at: row?.archived_changed_at ?? value.archived_changed_at ?? null,
				},
				row?.identity_key,
			),
		];
	});
	return withContent(
		{
			...snapshot,
			repos: [
				...current,
				...(includeRemoved ? rows.filter((row) => row.removed_at).map(catalogWireRow) : []),
			],
		},
		storedContent(snapshot),
	);
}
export async function readCatalogChanges(
	db: Db,
	account: string,
	query: Record<string, string[]>,
): Promise<CatalogChanges> {
	if (Object.keys(query).some((key) => key !== "since") || query.since?.length !== 1)
		throw new ApiError(400, "validation_failed", "A single since timestamp is required");
	const parsed = z.string().datetime({ offset: true }).safeParse(query.since[0]);
	if (!parsed.success) throw new ApiError(400, "validation_failed", "Invalid catalog cursor");
	const since = new Date(parsed.data).toISOString();
	const [states, events] = await db.batch<
		CatalogState & {
			event_id: string;
			kind: CatalogChangeKind | "unconfirmed";
			repo: string;
			github_id: string | null;
			at: string;
			source_kind: "factory" | "legacy";
			source_run_id: string | null;
			details: string;
			reason: CatalogUnconfirmedReason | null;
		}
	>([
		db.prepare("SELECT * FROM catalog_state WHERE account_id=?").bind(account),
		db
			.prepare(
				"SELECT event_id,kind,repo,github_id,at,source_kind,source_run_id,details,NULL AS reason FROM catalog_changes WHERE account_id=? AND at>=? AND at<=(SELECT checked_at FROM catalog_state WHERE account_id=?) UNION ALL SELECT event_id,'unconfirmed' AS kind,repo,github_id,at,source_kind,source_run_id,'{}' AS details,reason FROM catalog_unconfirmed WHERE account_id=? AND at>=? AND at<=(SELECT checked_at FROM catalog_state WHERE account_id=?) ORDER BY at,repo,event_id LIMIT 10001",
			)
			.bind(account, since, account, account, since, account),
	]);
	if (!states || !events) throw new ApiError(500, "db_error", "Incomplete catalog read");
	const state = states.results[0];
	if (!state?.checked_at)
		throw new ApiError(409, "catalog_unpublished", "Catalog history is not initialized");
	if (since < state.history_since)
		throw new ApiError(410, "catalog_history_expired", "Catalog cursor predates retained history");
	if (since > state.checked_at)
		throw new ApiError(
			400,
			"validation_failed",
			"Catalog cursor is after the last completed catalog",
		);
	if (events.results.length > 10000)
		throw new ApiError(409, "catalog_capacity", "Catalog retention must complete before reading");
	const result: CatalogChanges = {
		account_id: account,
		since,
		until: state.checked_at,
		history_since: state.history_since,
		warning_code: state.warning_code,
		unconfirmed: [],
		added: [],
		removed: [],
		archived: [],
		unarchived: [],
		visibility_changed: [],
		fork_changed: [],
		renamed: [],
	};
	for (const event of events.results) {
		const change: CatalogChange = {
			event_id: event.event_id,
			repo: event.repo,
			github_id: event.github_id,
			at: event.at,
			source: { kind: event.source_kind, runId: event.source_run_id },
			...JSON.parse(event.details),
		};
		if (event.kind === "unconfirmed")
			result.unconfirmed.push({ ...change, reason: event.reason as CatalogUnconfirmedReason });
		else result[event.kind].push(change);
	}
	return result;
}
