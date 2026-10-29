import { z } from "zod";
import type { CatalogChanges } from "../../lib/catalog-types";
import type { FactoryRepo } from "../../lib/factory-types";
import { type CatalogRow, catalogWireRow } from "./catalog-history";
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
	_db: Db,
	_account: string,
	query: Record<string, string[]>,
): Promise<CatalogChanges> {
	if (Object.keys(query).some((key) => key !== "since") || query.since?.length !== 1)
		throw new ApiError(400, "validation_failed", "A single since timestamp is required");
	const parsed = z.string().datetime({ offset: true }).safeParse(query.since[0]);
	if (!parsed.success) throw new ApiError(400, "validation_failed", "Invalid catalog cursor");
	throw new ApiError(
		409,
		"catalog_unpublished",
		"Current refresh observations do not retain catalog change history",
	);
}
