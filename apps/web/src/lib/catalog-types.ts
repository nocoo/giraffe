export type CatalogTimestamps = {
	first_seen_at: string | null;
	last_seen_at: string | null;
	removed_at: string | null;
	archived_changed_at: string | null;
};
export const CATALOG_CHANGE_KINDS = [
	"added",
	"removed",
	"archived",
	"unarchived",
	"visibility_changed",
	"fork_changed",
	"renamed",
] as const;
export type CatalogChangeKind = (typeof CATALOG_CHANGE_KINDS)[number];
export type CatalogChange = {
	event_id: string;
	repo: string;
	github_id: string | null;
	at: string;
	source: { kind: "factory" | "legacy"; runId: string | null };
	before?: boolean | string;
	after?: boolean | string;
	previous_repo?: string;
};
export const CATALOG_UNCONFIRMED_REASONS = [
	"private_unverifiable",
	"scope_unverifiable",
	"mass_removal_guard",
	"identity_unavailable",
	"budget_exhausted",
	"permission_denied",
	"github_unauthorized",
	"github_rate_limited",
	"github_error",
	"lookup_unverifiable",
] as const;
export type CatalogUnconfirmedReason = (typeof CATALOG_UNCONFIRMED_REASONS)[number];
export type CatalogUnconfirmed = CatalogChange & { reason: CatalogUnconfirmedReason };
export type CatalogChanges = Record<CatalogChangeKind, CatalogChange[]> & {
	account_id: string;
	since: string;
	until: string;
	history_since: string;
	warning_code: string | null;
	unconfirmed: CatalogUnconfirmed[];
};
