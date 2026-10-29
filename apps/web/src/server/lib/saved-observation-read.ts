import type { FactorySnapshot } from "../../lib/factory-types";
import type { CatalogRow } from "./catalog-history";
import { catalogView } from "./catalog-read";
import type { Db } from "./db/d1";
import { normalizePublication } from "./db/factory-runs";
import { snapshotFromRows } from "./db/snapshots";
import { ApiError } from "./errors";
import { factoryRateStatement, type SavedFactoryRateRow } from "./factory-rate";
import type { StarRow } from "./repo-stars";
import {
	type AccountObservationResource,
	accountBindings,
	accountIdSql,
	ciPagesStatement,
	logicalSnapshotStatement,
	observationAccountStatement,
	observationStarsStatement,
	publicationSnapshotStatement,
	repositoryPagesStatement,
	type SavedAccount,
} from "./saved-observation-statements";
import type { SnapshotPage } from "./snapshot-pages";
import { policyFromSaved } from "./snapshot-projection";
import { type SnapshotScope, selectionFromStars } from "./snapshot-scope";

export type PublicationPage = SnapshotPage & { logical: string };
export type SavedAccountRead = {
	account: { id: string; login: string } | null;
	catalogPages: SnapshotPage[];
	sourcePages: SnapshotPage[];
	repositoryPages: SnapshotPage[];
	ciPages: SnapshotPage[];
	stars: StarRow[];
	rateRows: SavedFactoryRateRow[];
	catalogHistory: CatalogRow[];
};
export function decodePublication(rows: PublicationPage[]): FactorySnapshot | null {
	const snapshot = snapshotFromRows(rows[0]?.logical ?? "factory", rows) as FactorySnapshot | null;
	return snapshot ? normalizePublication(snapshot) : null;
}
export function savedAccountPolicy(
	saved: SavedAccountRead,
	scope: SnapshotScope,
	catalog = snapshotFromRows("repos", saved.catalogPages),
	includeRemoved = false,
) {
	return policyFromSaved(
		catalogView(catalog, saved.catalogHistory, includeRemoved),
		selectionFromStars(saved.stars, scope),
		saved.account?.login ?? "",
		saved.catalogHistory,
	);
}
export function accountReadPlan(
	db: Db,
	account: SavedAccount,
	resource: AccountObservationResource,
	_scope: SnapshotScope,
	options: { rate?: boolean } = {},
) {
	const statements = [
		observationAccountStatement(db, account),
		observationStarsStatement(db, account),
		logicalSnapshotStatement(db, account, "repos"),
	];
	const sourceIndex = resource === "repos" ? 2 : statements.length;
	if (resource === "factory") statements.push(publicationSnapshotStatement(db, account));
	else if (resource !== "repos" && resource !== "ci")
		statements.push(logicalSnapshotStatement(db, account, resource));
	const repositoryIndex = statements.length;
	if (resource === "issues" || resource === "prs")
		statements.push(repositoryPagesStatement(db, account, resource));
	const ciIndex = statements.length;
	if (resource === "ci") statements.push(ciPagesStatement(db, account));
	const rateIndex = statements.length;
	if (resource === "factory" && options.rate) statements.push(factoryRateStatement(db, account));
	const historyIndex = statements.length;
	statements.push(
		db
			.prepare(
				`SELECT repo_id AS github_id,repo_id AS identity_key,repo,payload AS row_payload,fetched_at AS last_seen_at,NULL AS first_seen_at,NULL AS removed_at,NULL AS archived_changed_at,1 AS name_current FROM refresh_catalog WHERE account_id=${accountIdSql(account)} AND active=1 ORDER BY repo,repo_id`,
			)
			.bind(...accountBindings(account)),
	);
	return {
		statements,
		decode(results: D1Result<unknown>[]): SavedAccountRead {
			if (results.length < statements.length || statements.some((_, index) => !results[index]))
				throw new ApiError(500, "db_error", "incomplete observation batch");
			const rows = <T>(index: number) => results[index]?.results as T[];
			return {
				account: rows<SavedAccountRead["account"]>(0)[0] ?? null,
				stars: rows<StarRow>(1),
				catalogPages: rows<SnapshotPage>(2),
				sourcePages: resource === "ci" ? [] : rows<SnapshotPage>(sourceIndex),
				repositoryPages:
					resource === "issues" || resource === "prs" ? rows<SnapshotPage>(repositoryIndex) : [],
				ciPages: resource === "ci" ? rows<SnapshotPage>(ciIndex) : [],
				rateRows:
					resource === "factory" && options.rate ? rows<SavedFactoryRateRow>(rateIndex) : [],
				catalogHistory: rows<CatalogRow>(historyIndex),
			};
		},
	};
}
