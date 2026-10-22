import { z } from "zod";
import type { FactorySnapshot } from "../../lib/factory-types";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import { prSnapshot } from "../../lib/pull-request";
import { decodeContent, factoryStreamContent, storedContent } from "./content-version";
import type { Db } from "./db/d1";
import { normalizePublication } from "./db/factory-runs";
import { ApiError } from "./errors";
import {
	ciContent,
	ciObservationInputs,
	factoryContent,
	observationMetadata,
	observationVersion,
	projectCiInputs,
	projectFactoryObservation,
} from "./machine-observations";
import { assembleSnapshotGroups, latestSnapshots, type SnapshotPage } from "./snapshot-pages";
import { policyFromSaved, projectSnapshot } from "./snapshot-projection";
import { selectionFromStars } from "./snapshot-scope";
import type { SourceTiming } from "./source-timing";

const sourceQuerySchema = z
	.object({
		repository: z
			.string()
			.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
			.max(200)
			.optional(),
		since: z.string().datetime({ offset: true }).optional(),
	})
	.strict();

function afterSince(metadata: ReturnType<typeof observationMetadata>, since: number | null) {
	if (since === null) return true;
	const freshness = metadata.freshness;
	const latestAt =
		typeof freshness === "object" && freshness !== null && "latestAt" in freshness
			? freshness.latestAt
			: null;
	const times = [metadata.fetchedAt, latestAt]
		.map((at) => (typeof at === "string" ? Date.parse(at) : NaN))
		.filter(Number.isFinite);
	return !times.length || Math.max(...times) > since;
}

export async function readSources(
	db: Db,
	account: string,
	query: Record<string, string>,
	timing?: SourceTiming,
) {
	const parsed = sourceQuerySchema.safeParse(query);
	if (!parsed.success) throw new ApiError(400, "validation_failed", "invalid source filters");
	const head = `SELECT coalesce((SELECT 'factory:v:' || nullif(published_id,'') FROM factory_state WHERE account_id=?),'factory') AS kind`;
	const [catalogRows, stars, owners, publicationRows, rows] = await db.batch<
		SnapshotPage & { repo: string; login: string }
	>([
		db
			.prepare(
				"SELECT kind,payload,content_meta FROM snapshots WHERE account_id=? AND kind IN ('repos','repos#2')",
			)
			.bind(account),
		db.prepare("SELECT repo FROM repo_stars WHERE account_id=? ORDER BY repo").bind(account),
		db.prepare("SELECT login FROM accounts WHERE id=?").bind(account),
		db
			.prepare(
				`WITH head AS (${head}) SELECT s.kind,s.payload,s.content_meta FROM snapshots s, head WHERE s.account_id=? AND s.kind IN (head.kind,head.kind || '#2')`,
			)
			.bind(account, account),
		db
			.prepare(
				`WITH head AS (${head}), publication AS MATERIALIZED (
					SELECT json_extract(s.payload,'$.repos') AS repos,json_extract(root.payload,'$.runId') AS run_id
					FROM snapshots s,head JOIN snapshots root ON root.account_id=s.account_id AND root.kind=head.kind
					WHERE s.account_id=? AND s.kind IN (head.kind,head.kind || '#2')
				), refs AS MATERIALIZED (
					SELECT json_extract(value,'$.name') AS name,
						coalesce(json_extract(value,'$.observation.repo'),json_extract(value,'$.name')) AS repo,
						coalesce(json_extract(value,'$.observation.version'),publication.run_id) AS version,
						coalesce(json_extract(value,'$.observation.source'),'legacy') AS source
					FROM publication,json_each(publication.repos)
					WHERE (?='' OR lower(json_extract(value,'$.name'))=lower(?))
				), legacy AS (
					SELECT 'factory:' || repo || ':' || streams.value AS kind FROM refs, json_each(?) AS streams WHERE source!='run'
				)
				SELECT kind,payload,content_meta FROM snapshots WHERE account_id=? AND (
					kind IN ('issues','issues#2','prs','prs#2')
					OR (kind LIKE 'repo:%' AND (kind LIKE '%:issues' OR kind LIKE '%:issues#2' OR kind LIKE '%:prs' OR kind LIKE '%:prs#2' OR kind LIKE '%:actions' OR kind LIKE '%:actions#2' OR kind LIKE '%:releases' OR kind LIKE '%:releases#2' OR kind LIKE '%:details' OR kind LIKE '%:details#2'))
				)
				UNION ALL
				SELECT 'stream:' || refs.name || ':' || f.stream AS kind,NULL AS payload,f.content_meta
				FROM refs CROSS JOIN factory_runs r ON r.id=refs.version AND r.account_id=?
				CROSS JOIN factory_resources f INDEXED BY factory_resources_content ON f.run_id=r.id AND f.repo=refs.repo
				WHERE refs.source='run' AND f.stream IN (SELECT value FROM json_each(?))
				UNION ALL
				SELECT kind,NULL AS payload,content_meta FROM snapshots
				WHERE account_id=? AND kind IN (SELECT kind FROM legacy)`,
			)
			.bind(
				account,
				account,
				parsed.data.repository ?? "",
				parsed.data.repository ?? "",
				JSON.stringify(FACTORY_STREAMS),
				account,
				account,
				JSON.stringify(FACTORY_STREAMS),
				account,
			),
	]);
	if (!catalogRows || !stars || !owners || !publicationRows || !rows)
		throw new ApiError(500, "db_error", "incomplete source batch");
	const decode = <T>(fn: () => T) => (timing ? timing.measure("decode", fn) : fn());
	const hash = <T>(fn: () => Promise<T>) => (timing ? timing.measureAsync("hash", fn) : fn());
	const policy = decode(() =>
		policyFromSaved(
			assembleSnapshotGroups(catalogRows.results).get("repos") ?? null,
			selectionFromStars(stars.results, "all"),
			owners.results[0]?.login ?? "",
		),
	);
	const repository = parsed.data.repository
		? policy.repos.find(
				(repo) => repo.name_with_owner.toLowerCase() === parsed.data.repository?.toLowerCase(),
			)?.name_with_owner
		: undefined;
	if (parsed.data.repository && !repository)
		throw new ApiError(404, "not_found", "repository outside saved account catalog");
	const rawPublication = decode(() => assembleSnapshotGroups(publicationRows.results))
		.values()
		.next().value as FactorySnapshot | undefined;
	const publication = rawPublication ? normalizePublication(rawPublication) : null;
	const since = parsed.data.since ? Date.parse(parsed.data.since) : null;
	const streams = (publication?.repos ?? []).flatMap((repo) => {
		if (
			!policy.includes(repo.name) ||
			(repository && repo.name.toLowerCase() !== repository.toLowerCase())
		)
			return [];
		return FACTORY_STREAMS.flatMap((stream) => {
			const coverage = repo.coverage[stream];
			const data = {
				fetched_at: coverage.fetchedAt,
				freshness: {
					oldestAt: coverage.fetchedAt,
					latestAt: coverage.fetchedAt,
					total: 1,
					missing: coverage.status === "complete" ? 0 : 1,
				},
				coverage,
				truncated: coverage.status === "limited",
				unavailable:
					coverage.status === "pending" ||
					coverage.status === "partial" ||
					coverage.status === "unavailable",
			};
			return afterSince(observationMetadata(data), since) ? [{ repo, stream, data }] : [];
		});
	});
	const saved = decode(() =>
		assembleSnapshotGroups(rows.results.filter((row) => row.payload !== null)),
	);
	const streamMeta = decode(
		() =>
			new Map(
				rows.results
					.filter((row) => row.payload === null)
					.map((row) => [row.kind, decodeContent(row.content_meta)]),
			),
	);
	const groups = latestSnapshots(saved);
	type Source = { resource: string; version: string; contentVersion: string | null } & ReturnType<
		typeof observationMetadata
	>;
	const sources: Source[] = [];
	const add = async (
		resource: string,
		data: Record<string, unknown>,
		version: string | undefined = storedContent(data)?.fullVersion,
		content: string | null = storedContent(data)?.hash ?? null,
	) => {
		const metadata = observationMetadata(data);
		if (!afterSince(metadata, since)) return;
		data = prSnapshot(data);
		return {
			resource,
			version: version ?? (await hash(() => observationVersion(data))),
			contentVersion: content,
			...metadata,
		};
	};
	const indexed = await Promise.all(
		[...groups.values()].flatMap(({ resource, data }) => {
			if (!resource.toLowerCase().startsWith("repo:")) return [];
			const name = resource.slice(5, resource.lastIndexOf(":"));
			return policy.includes(name) &&
				(!repository || name.toLowerCase() === repository.toLowerCase())
				? [add(resource, data)]
				: [];
		}),
	);
	for (const source of indexed) if (source) sources.push(source);
	for (const resource of ["issues", "prs", "ci", "factory", "repos"]) {
		try {
			let data: Record<string, unknown>;
			let version: string | undefined;
			let content: string | null | undefined;
			if (resource === "factory") {
				if (!publication) continue;
				data = projectFactoryObservation(publication, policy);
				version = publication.publication?.runId ?? publication.runId;
			} else if (resource === "ci") {
				const inputs = ciObservationInputs(policy, groups);
				if (!afterSince(observationMetadata(inputs.metadata), since)) continue;
				data = projectCiInputs(inputs);
				content = await hash(() => ciContent(policy, groups, inputs.metadata.freshness));
			} else {
				const snapshot = resource === "repos" ? policy.catalog : saved.get(resource);
				if (!snapshot) continue;
				data = await hash(() => projectSnapshot(db, account, resource, snapshot, policy, saved));
			}
			const source = await add(
				`account:${resource}`,
				data,
				version,
				resource === "ci"
					? content
					: resource === "factory" && publication
						? await hash(() => factoryContent(publication, policy))
						: undefined,
			);
			if (source) sources.push(source);
		} catch (error) {
			if (!(error instanceof ApiError) || error.code !== "snapshot_missing") throw error;
		}
	}
	const repositories = policy.repos.map((repo) => repo.name_with_owner).sort();
	if (publication)
		for (const { repo, stream, data: metadata } of streams) {
			const version = repo.observation?.version ?? publication.runId;
			const meta = streamMeta.get(
				repo.observation?.source === "run"
					? `stream:${repo.name}:${stream}`
					: `factory:${repo.observation?.repo ?? repo.name}:${stream}`,
			);
			const source = await add(
				`factory:${repo.name}:${stream}`,
				metadata,
				version,
				await hash(async () =>
					factoryStreamContent(meta?.version === version ? meta.hash : null, repo.coverage[stream]),
				),
			);
			if (source) sources.push(source);
		}

	return { account_id: account, repositories, sources };
}
