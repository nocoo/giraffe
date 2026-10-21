import { z } from "zod";
import type { FactorySnapshot, FactoryStreamData } from "../../lib/factory-types";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import { prSnapshot } from "../../lib/pull-request";
import { contentVersion } from "./content-version";
import type { Db } from "./db/d1";
import { factoryHead, normalizePublication } from "./db/factory-runs";
import { ApiError } from "./errors";
import {
	ciContent,
	factoryResourceData,
	observationMetadata,
	observationVersion,
	projectCiObservation,
	projectFactoryObservation,
} from "./machine-observations";
import { projectSnapshot, repoPolicy } from "./repo-statistics";
import { assembleSnapshotGroups, latestSnapshots, type SnapshotPage } from "./snapshot-pages";

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

export async function readSources(db: Db, account: string, query: Record<string, string>) {
	const parsed = sourceQuerySchema.safeParse(query);
	if (!parsed.success) throw new ApiError(400, "validation_failed", "invalid source filters");
	const policy = await repoPolicy(db, account);
	const repository = parsed.data.repository
		? policy.repos.find(
				(repo) => repo.name_with_owner.toLowerCase() === parsed.data.repository?.toLowerCase(),
			)?.name_with_owner
		: undefined;
	if (parsed.data.repository && !repository)
		throw new ApiError(404, "not_found", "repository outside saved account catalog");
	const head = await factoryHead(db, account);
	const factoryKind = head?.published_id ? `factory:v:${head.published_id}` : "factory";
	const rows = await db
		.prepare(
			`WITH refs AS (
				SELECT json_extract(r.value,'$.name') AS name,
					coalesce(json_extract(r.value,'$.observation.repo'),json_extract(r.value,'$.name')) AS repo,
					coalesce(json_extract(r.value,'$.observation.version'),json_extract(s.payload,'$.runId')) AS version,
					coalesce(json_extract(r.value,'$.observation.source'),'legacy') AS source
				FROM snapshots s, json_each(s.payload,'$.repos') r
				WHERE s.account_id=? AND s.kind IN (?,?)
			), legacy AS (
				SELECT 'factory:' || refs.repo || ':' || streams.value AS kind
				FROM refs, json_each(?) streams WHERE refs.source!='run'
			)
			SELECT kind,payload FROM snapshots WHERE account_id=? AND (
				kind IN (?,?,?,?,?,?) OR kind IN (SELECT kind FROM legacy) OR kind IN (SELECT kind || '#2' FROM legacy)
				OR (kind LIKE 'repo:%' AND (kind LIKE '%:issues' OR kind LIKE '%:issues#2' OR kind LIKE '%:prs' OR kind LIKE '%:prs#2' OR kind LIKE '%:actions' OR kind LIKE '%:actions#2' OR kind LIKE '%:releases' OR kind LIKE '%:releases#2' OR kind LIKE '%:details' OR kind LIKE '%:details#2'))
			)
			UNION ALL
			SELECT 'stream:' || refs.name || ':' || f.stream AS kind,f.payload
			FROM refs JOIN factory_runs r ON r.id=refs.version AND r.account_id=?
			JOIN factory_resources f ON f.run_id=r.id AND f.repo=refs.repo
			WHERE refs.source='run'`,
		)
		.bind(
			account,
			factoryKind,
			`${factoryKind}#2`,
			JSON.stringify(FACTORY_STREAMS),
			account,
			"issues",
			"issues#2",
			"prs",
			"prs#2",
			factoryKind,
			`${factoryKind}#2`,
			account,
		)
		.all<SnapshotPage>();
	const saved = assembleSnapshotGroups(rows.results);
	const groups = latestSnapshots(saved);
	const rawPublication = saved.get(factoryKind) as FactorySnapshot | undefined;
	const publication = rawPublication ? normalizePublication(rawPublication) : null;
	const since = parsed.data.since ? Date.parse(parsed.data.since) : null;
	type Source = { resource: string; version: string; contentVersion: string | null } & ReturnType<
		typeof observationMetadata
	>;
	const sources: Source[] = [];
	const add = async (
		resource: string,
		data: Record<string, unknown>,
		version?: string,
		content?: Record<string, unknown> | null,
	) => {
		data = prSnapshot(data);
		const metadata = observationMetadata(data);
		if (since !== null) {
			const freshness = metadata.freshness;
			const latestAt =
				typeof freshness === "object" && freshness !== null && "latestAt" in freshness
					? freshness.latestAt
					: null;
			const times = [metadata.fetchedAt, latestAt]
				.map((at) => (typeof at === "string" ? Date.parse(at) : NaN))
				.filter(Number.isFinite);
			if (times.length && Math.max(...times) <= since) return;
		}
		return {
			resource,
			version: version ?? (await observationVersion(data)),
			contentVersion:
				content === null
					? null
					: await contentVersion(resource.replace(/^account:/, ""), content ?? data),
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
			if (resource === "factory") {
				if (!publication) continue;
				data = projectFactoryObservation(publication, policy);
				version = publication.publication?.runId ?? publication.runId;
			} else if (resource === "ci") data = projectCiObservation(policy, groups);
			else {
				const snapshot = resource === "repos" ? policy.catalog : saved.get(resource);
				if (!snapshot) continue;
				data = await projectSnapshot(db, account, resource, snapshot, policy, false, saved);
			}
			const source = await add(
				`account:${resource}`,
				data,
				version,
				resource === "ci" ? ciContent(policy, groups) : undefined,
			);
			if (source) sources.push(source);
		} catch (error) {
			if (!(error instanceof ApiError) || error.code !== "snapshot_missing") throw error;
		}
	}
	const repositories = policy.repos.map((repo) => repo.name_with_owner).sort();
	if (publication)
		for (const repo of publication.repos) {
			if (!policy.includes(repo.name)) continue;
			if (repository && repo.name.toLowerCase() !== repository.toLowerCase()) continue;
			for (const stream of FACTORY_STREAMS) {
				const coverage = repo.coverage[stream];
				const version = repo.observation?.version ?? publication.runId;
				const data = saved.get(
					repo.observation?.source === "run"
						? `stream:${repo.name}:${stream}`
						: `factory:${repo.observation?.repo ?? repo.name}:${stream}`,
				) as FactoryStreamData | undefined;
				const source = await add(
					`factory:${repo.name}:${stream}`,
					{
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
					},
					version,
					data?.runId === version ? factoryResourceData(publication, repo, stream, data) : null,
				);
				if (source) sources.push(source);
			}
		}

	return { account_id: account, repositories, sources };
}
