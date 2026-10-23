import { FACTORY_STREAMS } from "../../lib/factory-types";
import type { Db } from "./db/d1";

export type SavedAccount = string | null;
export type AccountObservationResource = "repos" | "issues" | "prs" | "ci" | "factory";
export const accountIdSql = (account: SavedAccount) =>
	account === null ? "(SELECT id FROM accounts WHERE is_active=1)" : "?";
export const accountBindings = (account: SavedAccount): string[] =>
	account === null ? [] : [account];

export function observationAccountStatement(db: Db, account: SavedAccount) {
	return db
		.prepare(`SELECT id,login FROM accounts WHERE id=${accountIdSql(account)}`)
		.bind(...accountBindings(account));
}
export function observationStarsStatement(db: Db, account: SavedAccount) {
	return db
		.prepare(
			`SELECT repo,starred,source,updated_at,reason FROM repo_stars WHERE account_id=${accountIdSql(account)} ORDER BY repo`,
		)
		.bind(...accountBindings(account));
}
export function logicalSnapshotStatement(db: Db, account: SavedAccount, logical: string) {
	return db
		.prepare(
			`SELECT kind, payload, content_meta FROM snapshots WHERE account_id = ${accountIdSql(account)} AND kind IN (?, ?)`,
		)
		.bind(...accountBindings(account), logical, `${logical}#2`);
}
export function repositoryPagesStatement(db: Db, account: SavedAccount, suffix: string) {
	return db
		.prepare(
			`SELECT kind, payload, content_meta FROM snapshots WHERE account_id=${accountIdSql(account)} AND (kind LIKE ? OR kind LIKE ?)`,
		)
		.bind(...accountBindings(account), `repo:%:${suffix}`, `repo:%:${suffix}#2`);
}
export function ciPagesStatement(db: Db, account: SavedAccount) {
	return db
		.prepare(
			`SELECT kind, payload, fetched_at, content_meta FROM snapshots WHERE account_id=${accountIdSql(account)} AND kind LIKE 'repo:%' AND (kind LIKE '%:actions' OR kind LIKE '%:actions#2' OR kind LIKE '%:releases' OR kind LIKE '%:releases#2' OR kind LIKE '%:details' OR kind LIKE '%:details#2')`,
		)
		.bind(...accountBindings(account));
}
export function publicationSnapshotStatement(db: Db, account: SavedAccount) {
	return db
		.prepare(`WITH head AS (SELECT coalesce((SELECT 'factory:v:' || nullif(published_id,'') FROM factory_state WHERE account_id=${accountIdSql(account)}),'factory') AS logical)
 SELECT s.kind,s.payload,s.content_meta,head.logical FROM snapshots s,head WHERE s.account_id=${accountIdSql(account)} AND s.kind IN (head.logical,head.logical || '#2')`)
		.bind(...accountBindings(account), ...accountBindings(account));
}

export function publicationRetentionStatement(
	db: Db,
	account: string,
	names: string[],
	identities: string[],
) {
	return db
		.prepare(
			`WITH head AS (
 SELECT coalesce((SELECT 'factory:v:' || nullif(published_id,'') FROM factory_state WHERE account_id=?),'factory') AS logical
), publication AS (
 SELECT saved.kind,saved.payload FROM head
 JOIN snapshots root ON root.account_id=? AND root.kind=head.logical
 JOIN snapshots saved ON saved.account_id=root.account_id AND saved.kind IN (head.logical,head.logical || '#2')
)
SELECT json_object('id',json_extract(repository.value,'$.id'),'name',json_extract(repository.value,'$.name'),
 'coverage',json((SELECT json_group_object(stream.value,json_object('retained',json(CASE
  WHEN json_type(repository.value,'$.coverage.' || stream.value || '.retained')='true' THEN 'true' ELSE 'false' END)))
  FROM json_each(?) stream))) AS payload
FROM publication,json_each(publication.payload,'$.repos') repository
WHERE lower(json_extract(repository.value,'$.name')) IN (SELECT value FROM json_each(?))
 OR json_extract(repository.value,'$.id') IN (SELECT value FROM json_each(?))
ORDER BY publication.kind,CAST(repository.key AS INTEGER)`,
		)
		.bind(
			account,
			account,
			JSON.stringify(FACTORY_STREAMS),
			JSON.stringify(names),
			JSON.stringify(identities),
		);
}
