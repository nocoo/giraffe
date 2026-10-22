import type {
	FactoryRepo,
	FactorySnapshot,
	FactoryStreamData,
	FactoryStreamName,
} from "../../lib/factory-types";
import { decodeContent, storedContent } from "./content-version";
import type { Db } from "./db/d1";
import { snapshotFromRows } from "./db/snapshots";
import { ApiError } from "./errors";
import { streamKey } from "./factory-collect";
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
				"SELECT kind,payload,content_meta FROM snapshots WHERE account_id=? AND kind COLLATE NOCASE IN (?,?)",
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

export type FactoryResourceRow = SnapshotPage & { source: "run" | "legacy" };
export type SavedFactoryStream = {
	account: { id: string; login: string } | null;
	stars: StarRow[];
	catalogPages: SnapshotPage[];
	publicationPages: PublicationPage[];
	resourcePages: FactoryResourceRow[];
};

function referencedResourceStatement(db: Db, account: SavedAccount, name: string, stream: string) {
	return db
		.prepare(`WITH target AS (SELECT ${accountIdSql(account)} AS account,? AS name,? AS stream),
 head AS (SELECT target.*,coalesce((SELECT 'factory:v:' || nullif(published_id,'') FROM factory_state WHERE account_id=target.account),'factory') AS logical FROM target),
 roots AS MATERIALIZED (SELECT head.*,CASE WHEN json_valid(s.payload,2) THEN s.payload END AS root_payload FROM head JOIN snapshots s ON s.account_id=head.account AND s.kind=head.logical),
 pages AS (
 SELECT roots.*,0 AS ordinal,root_payload AS payload FROM roots
 UNION ALL
 SELECT roots.*,1 AS ordinal,CASE WHEN json_valid(s.payload,2) THEN s.payload END AS payload
 FROM roots JOIN snapshots s ON s.account_id=roots.account AND s.kind=roots.logical || '#2'
 WHERE (SELECT key FROM json_each(roots.root_payload) WHERE type='array' LIMIT 1)='repos'
 ),
 candidates AS (SELECT pages.*,j.key AS position,CASE WHEN j.type='object' THEN j.value ELSE '{}' END AS repo
 FROM pages,json_each(CASE WHEN json_type(pages.payload,'$.repos')='array' THEN json_extract(pages.payload,'$.repos') END) j),
 refs AS MATERIALIZED (SELECT account,stream,
 coalesce(json_extract(repo,'$.observation.repo'),json_extract(repo,'$.name')) AS repo,
 coalesce(json_extract(repo,'$.observation.version'),json_extract(root_payload,'$.runId')) AS version,
 coalesce(json_extract(repo,'$.observation.source'),'legacy') AS source
 FROM candidates WHERE lower(json_extract(repo,'$.name'))=lower(name) ORDER BY ordinal,position LIMIT 1)
 SELECT 'run' AS source,'' AS kind,f.payload,f.content_meta FROM refs
 JOIN factory_runs r ON r.id=refs.version AND r.account_id=refs.account
 JOIN factory_resources f ON f.run_id=r.id AND f.repo=refs.repo AND f.stream=refs.stream WHERE refs.source='run'
 UNION ALL
 SELECT 'legacy' AS source,s.kind,s.payload,s.content_meta FROM refs JOIN snapshots s
 ON s.account_id=refs.account AND s.kind IN ('factory:' || refs.repo || ':' || refs.stream,'factory:' || refs.repo || ':' || refs.stream || '#2') WHERE refs.source!='run'`)
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
			};
		},
	};
}

export function factoryStreamPolicy(saved: SavedFactoryStream, scope: SnapshotScope) {
	return policyFromSaved(
		snapshotFromRows("repos", saved.catalogPages),
		selectionFromStars(saved.stars, scope),
		saved.account?.login ?? "",
	);
}

export function decodeFactoryResource(
	saved: SavedFactoryStream,
	snap: FactorySnapshot,
	repo: FactoryRepo,
	stream: string,
	withContent = false,
) {
	const version = repo.observation?.version ?? snap.runId;
	const original = repo.observation?.repo ?? repo.name;
	let data: FactoryStreamData | null;
	let content: string | null = null;
	if (repo.observation?.source === "run") {
		const row = saved.resourcePages.find((item) => item.source === "run");
		data = row ? (JSON.parse(row.payload) as FactoryStreamData) : null;
		if (withContent) {
			const meta = decodeContent(row?.content_meta);
			content = meta?.version === version ? meta.hash : null;
		}
	} else {
		data = snapshotFromRows(
			streamKey(original, stream as FactoryStreamName),
			saved.resourcePages,
		) as FactoryStreamData | null;
		const meta = storedContent(data);
		content = meta?.version === version ? meta.hash : null;
	}
	return { data, content };
}
