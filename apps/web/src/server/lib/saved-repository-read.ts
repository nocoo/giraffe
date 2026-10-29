import type {
	FactoryRepo,
	FactorySnapshot,
	FactoryStreamData,
	FactoryStreamName,
} from "../../lib/factory-types";
import type { CatalogRow } from "./catalog-history";
import { decodeContent } from "./content-version";
import type { Db } from "./db/d1";
import { snapshotFromRows } from "./db/snapshots";
import { ApiError } from "./errors";
import type { StarRow } from "./repo-stars";
import type { PublicationPage } from "./saved-observation-read";
import {
	accountBindings,
	accountIdSql,
	logicalSnapshotStatement,
	observationAccountStatement,
	observationStarsStatement,
	publicationSnapshotStatement,
	type SavedAccount,
} from "./saved-observation-statements";
import type { SnapshotPage } from "./snapshot-pages";
import { policyFromSaved } from "./snapshot-projection";
import { type SnapshotScope, selectionFromStars } from "./snapshot-scope";

export function repositoryReadPlan(db: Db, account: string, name: string, tab: string) {
	const logical = `repo:${name}:${tab}`;
	const statements = [
		logicalSnapshotStatement(db, account, "repos"),
		db
			.prepare(
				"SELECT kind,payload,content_meta FROM refresh_snapshots WHERE account_id=? AND kind COLLATE NOCASE IN (?,?)",
			)
			.bind(account, logical, `${logical}#2`),
	];
	return {
		statements,
		decode(results: D1Result<SnapshotPage>[]) {
			if (!results[0] || !results[1])
				throw new ApiError(500, "db_error", "incomplete repository batch");
			return { catalogPages: results[0].results, pages: results[1].results };
		},
	};
}

export type FactoryResourceRow = SnapshotPage & { source: "run" };
export type SavedFactoryStream = {
	account: { id: string; login: string } | null;
	stars: StarRow[];
	catalogPages: SnapshotPage[];
	publicationPages: PublicationPage[];
	resourcePages: FactoryResourceRow[];
	catalogHistory: CatalogRow[];
};

function referencedResourceStatement(db: Db, account: SavedAccount, name: string, stream: string) {
	return db
		.prepare(
			`SELECT 'run' AS source,'' AS kind,r.payload,r.content_meta FROM refresh_resources r JOIN refresh_catalog c ON c.account_id=r.account_id AND c.repo_id=r.repo_id WHERE c.account_id=${accountIdSql(account)} AND c.repo=? COLLATE NOCASE AND c.active=1 AND r.stream=?`,
		)
		.bind(...accountBindings(account), name, stream);
}

export function factoryStreamReadPlan(
	db: Db,
	account: SavedAccount,
	name: string,
	stream: string,
	options: { catalog?: boolean; policy?: boolean } = {},
) {
	const statements: D1PreparedStatement[] = [];
	if (options.policy)
		statements.push(
			observationAccountStatement(db, account),
			observationStarsStatement(db, account),
		);
	const catalogIndex = statements.length;
	if (options.catalog || options.policy)
		statements.push(logicalSnapshotStatement(db, account, "repos"));
	const publicationIndex = statements.length;
	statements.push(publicationSnapshotStatement(db, account));
	const resourceIndex = statements.length;
	statements.push(referencedResourceStatement(db, account, name, stream));
	const historyIndex = statements.length;
	statements.push(
		db
			.prepare(
				`SELECT repo_id AS github_id,repo_id AS identity_key,repo,payload AS row_payload,fetched_at AS last_seen_at,NULL AS first_seen_at,NULL AS removed_at,NULL AS archived_changed_at,1 AS name_current FROM refresh_catalog WHERE account_id=${accountIdSql(account)} AND repo=? COLLATE NOCASE AND active=1`,
			)
			.bind(...accountBindings(account), name),
	);
	return {
		statements,
		decode(results: D1Result<unknown>[]): SavedFactoryStream {
			if (results.length < statements.length || statements.some((_, i) => !results[i]))
				throw new ApiError(500, "db_error", "incomplete stream batch");
			const rows = <T>(index: number) => results[index]?.results as T[];
			return {
				account: options.policy ? (rows<SavedFactoryStream["account"]>(0)[0] ?? null) : null,
				stars: options.policy ? rows<StarRow>(1) : [],
				catalogPages: options.catalog || options.policy ? rows<SnapshotPage>(catalogIndex) : [],
				publicationPages: rows<PublicationPage>(publicationIndex),
				resourcePages: rows<FactoryResourceRow>(resourceIndex),
				catalogHistory: rows<CatalogRow>(historyIndex),
			};
		},
	};
}

export function factoryStreamPolicy(saved: SavedFactoryStream, scope: SnapshotScope) {
	return policyFromSaved(
		snapshotFromRows("repos", saved.catalogPages),
		selectionFromStars(saved.stars, scope),
		saved.account?.login ?? "",
		saved.catalogHistory,
	);
}

export function decodeFactoryResource(
	saved: SavedFactoryStream,
	snap: FactorySnapshot,
	repo: FactoryRepo,
	stream: string,
	withContent = false,
) {
	const coverage = repo.coverage[stream as FactoryStreamName];
	const version = coverage.observation?.version ?? repo.observation?.version ?? snap.runId;
	if (
		stream === "dependencies" &&
		coverage.status === "unavailable" &&
		coverage.reason === "dependency_analysis_unavailable"
	) {
		const data: FactoryStreamData = {
			runId: version,
			items: [],
			next: null,
			ranges: [snap.window],
			coverage,
		};
		return { data, content: null };
	}
	const row = saved.resourcePages[0];
	const data = row ? (JSON.parse(row.payload) as FactoryStreamData) : null;
	const meta = withContent ? decodeContent(row?.content_meta) : null;
	const content = meta?.version === version ? meta.hash : null;
	return { data, content };
}
