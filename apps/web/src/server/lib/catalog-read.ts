import { z } from "zod";
import {
	CATALOG_CHANGE_KINDS,
	type CatalogChangeKind,
	type CatalogChanges,
} from "../../lib/catalog-types";
import type { FactoryRepo } from "../../lib/factory-types";
import { type CatalogRow, type CatalogState, catalogWireRow } from "./catalog-history";
import { storedContent, withContent } from "./content-version";
import type { Db } from "./db/d1";
import { ApiError } from "./errors";

export function catalogFactoryRepo(repo: FactoryRepo, rows: CatalogRow[]): FactoryRepo | null {
	const current = rows.find((row) => row.github_id === repo.id && !row.removed_at);
	if (!current) {
		const named = rows.find(
			(row) => row.repo.toLowerCase() === repo.name.toLowerCase() && !row.removed_at,
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
				row.repo.toLowerCase() === String(value.name_with_owner).toLowerCase() && !row.removed_at,
		);
		if (
			!row &&
			rows.some(
				(row) =>
					row.repo.toLowerCase() === String(value.name_with_owner).toLowerCase() && row.removed_at,
			)
		)
			return [];
		return [
			{
				...value,
				first_seen_at: row?.first_seen_at ?? value.first_seen_at ?? null,
				last_seen_at: row?.last_seen_at ?? value.last_seen_at ?? null,
				removed_at: null,
				archived_changed_at: row?.archived_changed_at ?? value.archived_changed_at ?? null,
			},
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
			kind: CatalogChangeKind;
			repo: string;
			github_id: string | null;
			at: string;
			source_kind: "factory" | "legacy";
			source_run_id: string | null;
			details: string;
		}
	>([
		db.prepare("SELECT * FROM catalog_state WHERE account_id=?").bind(account),
		db
			.prepare(
				"SELECT * FROM catalog_changes WHERE account_id=? AND at>=? AND at<=(SELECT checked_at FROM catalog_state WHERE account_id=?) ORDER BY at,repo,event_id LIMIT 10001",
			)
			.bind(account, since, account),
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
	const result = {
		account_id: account,
		since,
		until: state.checked_at,
		history_since: state.history_since,
		warning_code: state.warning_code,
		...Object.fromEntries(CATALOG_CHANGE_KINDS.map((kind) => [kind, []])),
	} as CatalogChanges;
	for (const event of events.results)
		result[event.kind].push({
			event_id: event.event_id,
			repo: event.repo,
			github_id: event.github_id,
			at: event.at,
			source: { kind: event.source_kind, runId: event.source_run_id },
			...JSON.parse(event.details),
		});
	return result;
}
