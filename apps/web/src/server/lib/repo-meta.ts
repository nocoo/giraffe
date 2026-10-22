import {
	type RepoCategory,
	type RepoMeta,
	type RepoMetaFields,
	repoMetaWriteSchema,
} from "../../lib/repo-meta";
import { catalogRowIdentity, identifyCatalogRow } from "./catalog-identity";
import type { Db } from "./db/d1";
import { ApiError } from "./errors";

type Source = "agent" | "catalog" | null;
type MetaRow = {
	identity_key: string;
	repo: string;
	first_seen_at: string | null;
	removed_at: string | null;
	created_at: string | null;
	archived_at: string | null;
	category: RepoCategory | null;
	exclusion_reason: string | null;
	updated_at: string | null;
	created_at_source: Source;
	archived_at_source: Source;
	category_source: Source;
	exclusion_reason_source: Source;
};
const TARGET =
	"SELECT identity_key FROM catalog_repositories WHERE account_id=? AND repo=? COLLATE NOCASE AND (name_current=1 OR removed_at IS NOT NULL) ORDER BY CASE WHEN removed_at IS NULL THEN 0 ELSE 1 END,removed_at DESC,identity_key DESC LIMIT 1";
const COLUMNS =
	"c.identity_key,c.repo,c.first_seen_at,c.removed_at,m.created_at,m.archived_at,m.category,m.exclusion_reason,m.updated_at,m.created_at_source,m.archived_at_source,m.category_source,m.exclusion_reason_source";
const FIELDS = ["created_at", "archived_at", "category", "exclusion_reason"] as const;

function fields(row: MetaRow): RepoMetaFields {
	const field_sources: RepoMetaFields["field_sources"] = {};
	for (const field of FIELDS) {
		const source = row[`${field}_source`];
		if (source !== null) field_sources[field] = source;
	}
	return {
		created_at: row.created_at,
		first_seen_at: row.first_seen_at,
		archived_at: row.archived_at,
		deleted_at: row.removed_at,
		category: row.category,
		exclusion_reason: row.exclusion_reason,
		updated_at: row.updated_at,
		field_sources,
	};
}
function wire(account: string, row: MetaRow): RepoMeta {
	return {
		account_id: account,
		repo: row.repo,
		repo_removed: row.removed_at !== null,
		...fields(row),
	};
}
export async function readRepoMeta(db: Db, account: string, name: string): Promise<RepoMeta> {
	const row = await db
		.prepare(
			`SELECT ${COLUMNS} FROM catalog_repositories c LEFT JOIN repo_meta m ON m.account_id=c.account_id AND m.identity_key=c.identity_key WHERE c.account_id=? AND c.identity_key=(${TARGET})`,
		)
		.bind(account, account, name)
		.first<MetaRow>();
	if (!row) throw new ApiError(404, "not_found", "Repository not found");
	return wire(account, row);
}
export async function writeRepoMeta(
	db: Db,
	account: string,
	name: string,
	input: unknown,
): Promise<RepoMeta> {
	const parsed = repoMetaWriteSchema.safeParse(input);
	if (!parsed.success) throw new ApiError(400, "invalid_payload", "Invalid repository metadata");
	const patch = parsed.data;
	const columns = FIELDS.flatMap((field) => [field, `${field}_source`]);
	const updates = columns
		.map((column) => `${column}=COALESCE(excluded.${column},repo_meta.${column})`)
		.join(",");
	const values = FIELDS.flatMap((field) => [
		patch[field] ?? null,
		patch[field] === undefined ? null : "agent",
	]);
	const row = await db
		.prepare(
			`INSERT INTO repo_meta(account_id,identity_key,${columns.join(",")},updated_at) SELECT ?,identity_key,${columns.map(() => "?").join(",")},? FROM catalog_repositories WHERE account_id=? AND identity_key=(${TARGET}) ON CONFLICT(account_id,identity_key) DO UPDATE SET ${updates},updated_at=excluded.updated_at RETURNING *,(SELECT repo FROM catalog_repositories c WHERE c.account_id=repo_meta.account_id AND c.identity_key=repo_meta.identity_key) AS repo,(SELECT first_seen_at FROM catalog_repositories c WHERE c.account_id=repo_meta.account_id AND c.identity_key=repo_meta.identity_key) AS first_seen_at,(SELECT removed_at FROM catalog_repositories c WHERE c.account_id=repo_meta.account_id AND c.identity_key=repo_meta.identity_key) AS removed_at`,
		)
		.bind(account, ...values, new Date().toISOString(), account, account, name)
		.first<MetaRow>();
	if (!row) throw new ApiError(404, "not_found", "Repository not found");
	return wire(account, row);
}
export async function enrichRepoMeta(db: Db, account: string, data: Record<string, unknown>) {
	const repos = (Array.isArray(data.repos) ? data.repos : []) as Record<string, unknown>[];
	if (!repos.length) return { ...data, repos: [] as Record<string, unknown>[] };
	const result = await db
		.prepare(
			`SELECT ${COLUMNS} FROM catalog_repositories c LEFT JOIN repo_meta m ON m.account_id=c.account_id AND m.identity_key=c.identity_key WHERE c.account_id=?`,
		)
		.bind(account)
		.all<MetaRow>();
	const rows = new Map(result.results.map((row) => [row.identity_key, row]));
	return {
		...data,
		repos: repos.map((repo) => {
			const identity = catalogRowIdentity(repo);
			const row = identity === undefined ? undefined : rows.get(identity);
			return identifyCatalogRow({ ...repo, meta: row ? fields(row) : null }, identity);
		}),
	};
}
