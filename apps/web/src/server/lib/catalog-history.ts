import type { CatalogTimestamps } from "../../lib/catalog-types";
import { identifyCatalogRow } from "./catalog-identity";

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
	created_at?: string | null;
};
export type CatalogState = {
	history_since: string;
	checked_at: string | null;
	revision: number;
	source_run_id: string | null;
	warning_code: string | null;
};

export function catalogWireRow(row: CatalogRow): Record<string, unknown> {
	return identifyCatalogRow(
		{
			...JSON.parse(row.row_payload),
			first_seen_at: row.first_seen_at,
			last_seen_at: row.last_seen_at,
			removed_at: row.removed_at,
			archived_changed_at: row.archived_changed_at,
		},
		row.identity_key,
	);
}
