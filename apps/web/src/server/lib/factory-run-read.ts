import type { RepoRefreshState } from "../../lib/factory-run";
import type { FactorySnapshot } from "../../lib/factory-types";
import type { Db } from "./db/d1";
import {
	decodeRuns,
	type FactoryHead,
	listRunsStatement,
	normalizePublication,
	type RunListRow,
} from "./db/factory-runs";
import { snapshotFromRows } from "./db/snapshots";
import { ApiError } from "./errors";
import {
	decodeFactoryStorage,
	type FactoryStorage,
	factoryStorageStatement,
} from "./factory-retention";
import { siteCatalogFromPolicy } from "./factory-site";
import { decodeRunEstimates, type RunEstimateRow, runEstimateStatement } from "./run-estimates";
import {
	accountReadPlan,
	type PublicationPage,
	savedAccountPolicy,
} from "./saved-observation-read";
import { projectFactory } from "./snapshot-projection";

export async function readFactoryRunInputs(db: Db, account: string, detail: string) {
	const plan = accountReadPlan(db, account, "repos", "all");
	const results = await db.batch([
		...plan.statements,
		listRunsStatement(db, account, detail),
		runEstimateStatement(db, account),
		db
			.prepare("SELECT published_id,catalog_id,next_at FROM factory_state WHERE account_id=?")
			.bind(account),
		db
			.prepare(`WITH head AS (
 SELECT COALESCE((SELECT COALESCE('factory:catalog:' || NULLIF(catalog_id,''),'factory:v:' || NULLIF(published_id,''),'factory') FROM factory_state WHERE account_id=?),'factory') AS logical,
 COALESCE((SELECT CASE WHEN COALESCE(catalog_id,'')='' THEN 1 ELSE 0 END FROM factory_state WHERE account_id=?),1) AS normalize
 ) SELECT s.kind,s.payload,s.content_meta,head.logical,head.normalize FROM snapshots s,head WHERE s.account_id=? AND s.kind IN (head.logical,head.logical || '#2')`)
			.bind(account, account, account),
		db
			.prepare("SELECT payload FROM factory_repo_state WHERE account_id=? ORDER BY repo")
			.bind(account),
		factoryStorageStatement(db, account),
	]);
	const extras = results.slice(plan.statements.length);
	if (extras.length !== 6 || Array.from(extras).some((result) => !result))
		throw new ApiError(500, "db_error", "incomplete run batch");
	const rows = <Row>(index: number) => extras[index]?.results as Row[];
	const policy = savedAccountPolicy(plan.decode(results), "all");
	const pages = rows<PublicationPage & { normalize: number }>(3);
	const source = snapshotFromRows(pages[0]?.logical ?? "factory", pages) as FactorySnapshot | null;
	const rawCatalog = source && pages[0]?.normalize ? normalizePublication(source) : source;
	return {
		runs: decodeRuns(rows<RunListRow>(0)),
		calibration: decodeRunEstimates(rows<RunEstimateRow>(1)),
		head: rows<FactoryHead>(2)[0] ?? null,
		catalog: rawCatalog ? projectFactory(rawCatalog, policy) : null,
		policy,
		siteRepos: siteCatalogFromPolicy(policy),
		states: rows<{ payload: string }>(4).map((row) => JSON.parse(row.payload) as RepoRefreshState),
		storage: decodeFactoryStorage(rows<FactoryStorage>(5)[0]),
	};
}
