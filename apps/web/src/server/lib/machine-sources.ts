import { z } from "zod";
import type { FactoryCoverage, FactoryWindow } from "../../lib/factory-types";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import { prSnapshot } from "../../lib/pull-request";
import { factoryStreamFreshness, snapshotFreshness } from "../../lib/snapshot-freshness";
import { activityEvidenceCoverage } from "./activity-projection";
import {
	activityCoverageSummary,
	activityPublication,
	activityPublicationSql,
} from "./activity-store";
import type { CatalogRow } from "./catalog-history";
import { catalogView } from "./catalog-read";
import {
	composeContent,
	decodeContent,
	factoryStreamContent,
	storedContent,
} from "./content-version";
import type { Db } from "./db/d1";
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
import type { StarRow } from "./repo-stars";
import { assembleSnapshotGroups, latestSnapshots, type SnapshotPage } from "./snapshot-pages";
import { factoryObserved, policyFromSaved, projectSnapshot } from "./snapshot-projection";
import { selectionFromStars } from "./snapshot-scope";
import type { SourceTiming } from "./source-timing";

const ACTIVITY_STREAMS = ["issues", "prs", "actions", "releases"] as const;
type ActivityStream = (typeof ACTIVITY_STREAMS)[number];
type ResourceMetaRow = {
	kind: string;
	content_meta?: string | null;
	repo_id?: string | null;
	stream?: string | null;
	run_id?: string | null;
	coverage?: string | null;
	ranges?: string | null;
	next?: string | null;
	has_next?: number | null;
};
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

type SourcePublication = { runId?: string; publishedAt?: string | null };

function sourceMetadata(
	data: Record<string, unknown>,
	publication = data.publication as SourcePublication | undefined,
) {
	const metadata = observationMetadata(data);
	return {
		...metadata,
		runId: publication?.runId ?? null,
		observedAt: metadata.fetchedAt,
		fetchedAt: publication?.publishedAt ?? metadata.fetchedAt,
	};
}

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
	const [catalogRows, stars, owners, publicationRows, rows, resourceRows, historyRows] =
		await db.batch<SnapshotPage & StarRow & CatalogRow & { login: string }>([
			db
				.prepare(
					"SELECT kind,payload,content_meta FROM refresh_snapshots WHERE account_id=? AND kind IN ('repos','repos#2')",
				)
				.bind(account),
			db
				.prepare(
					"SELECT repo,starred,source,updated_at,reason FROM repo_stars WHERE account_id=? ORDER BY repo",
				)
				.bind(account),
			db.prepare("SELECT login FROM accounts WHERE id=?").bind(account),
			db.prepare(activityPublicationSql).bind(account),
			db
				.prepare(
					"SELECT kind,payload,content_meta FROM refresh_snapshots WHERE account_id=? AND (kind IN ('issues','issues#2','prs','prs#2') OR (kind LIKE 'repo:%' AND (kind LIKE '%:issues' OR kind LIKE '%:issues#2' OR kind LIKE '%:prs' OR kind LIKE '%:prs#2' OR kind LIKE '%:actions' OR kind LIKE '%:actions#2' OR kind LIKE '%:releases' OR kind LIKE '%:releases#2' OR kind LIKE '%:details' OR kind LIKE '%:details#2')))",
				)
				.bind(account),
			db
				.prepare(
					"SELECT 'stream:' || c.repo || ':' || r.stream AS kind,r.content_meta,c.repo_id AS repo_id,r.stream AS stream,CASE WHEN json_valid(r.payload) THEN json_extract(r.payload,'$.runId') END AS run_id,CASE WHEN json_valid(r.payload) THEN json_extract(r.payload,'$.coverage') END AS coverage,CASE WHEN json_valid(r.payload) THEN json_extract(r.payload,'$.ranges') END AS ranges,CASE WHEN json_valid(r.payload) THEN json_extract(r.payload,'$.next') END AS next,CASE WHEN json_valid(r.payload) THEN json_type(r.payload,'$.next') IS NOT NULL END AS has_next FROM refresh_resources r JOIN refresh_catalog c ON c.account_id=r.account_id AND c.repo_id=r.repo_id WHERE r.account_id=? AND c.active=1",
				)
				.bind(account),
			db
				.prepare(
					"SELECT repo_id AS github_id,repo_id AS identity_key,repo,payload AS row_payload,fetched_at AS last_seen_at,NULL AS first_seen_at,NULL AS removed_at,NULL AS archived_changed_at,1 AS name_current FROM refresh_catalog WHERE account_id=? AND active=1 ORDER BY repo,repo_id",
				)
				.bind(account),
		]);
	if (
		!catalogRows ||
		!stars ||
		!owners ||
		!publicationRows ||
		!rows ||
		!resourceRows ||
		!historyRows
	)
		throw new ApiError(500, "db_error", "incomplete source batch");
	if (timing) {
		const inputs = [
			...catalogRows.results,
			...publicationRows.results,
			...rows.results,
			...resourceRows.results,
		];
		timing.work("decoded_rows", inputs.length);
		timing.work(
			"decoded_bytes",
			inputs.reduce(
				(total, row) =>
					total +
					new TextEncoder().encode(`${row.payload ?? ""}${row.content_meta ?? ""}`).byteLength,
				0,
			),
		);
	}
	const decode = <T>(fn: () => T) => (timing ? timing.measure("decode", fn) : fn());
	const hash = <T>(fn: () => Promise<T>) => (timing ? timing.measureAsync("hash", fn) : fn());
	const policy = decode(() =>
		policyFromSaved(
			catalogView(
				assembleSnapshotGroups(catalogRows.results).get("repos") ?? null,
				historyRows.results,
			),
			selectionFromStars(stars.results, "all"),
			owners.results[0]?.login ?? "",
			historyRows.results,
		),
	);
	const repository = parsed.data.repository
		? policy.repos.find(
				(repo) => repo.name_with_owner.toLowerCase() === parsed.data.repository?.toLowerCase(),
			)?.name_with_owner
		: undefined;
	if (parsed.data.repository && !repository)
		throw new ApiError(404, "not_found", "repository outside saved account catalog");
	const publication = decode(() => activityPublication(publicationRows.results));
	const since = parsed.data.since ? Date.parse(parsed.data.since) : null;
	const resources = decode(() => resourceRows.results as unknown as ResourceMetaRow[]);
	const resourceCoverage = new Map(
		resources.map((row) => [
			`${row.repo_id}:${row.stream}`,
			row.coverage ? (JSON.parse(row.coverage) as FactoryCoverage) : null,
		]),
	);
	const streams = (publication ? factoryObserved(publication, policy) : []).flatMap((repo) => {
		if (
			!policy.includes(repo.name) ||
			(repository && repo.name.toLowerCase() !== repository.toLowerCase())
		)
			return [];
		return FACTORY_STREAMS.flatMap((stream) => {
			const coverage = repo.coverage[stream].retained
				? repo.coverage[stream]
				: (resourceCoverage.get(`${repo.id}:${stream}`) ?? repo.coverage[stream]);
			const observation = coverage.observation ?? repo.observation;
			const provenance = {
				...(observation?.publishedAt ? { publishedAt: observation.publishedAt } : {}),
			};
			const data = {
				fetched_at: coverage.fetchedAt,
				freshness: factoryStreamFreshness(coverage),
				coverage,
				truncated: coverage.status === "limited",
				unavailable:
					coverage.status === "pending" ||
					coverage.status === "partial" ||
					coverage.status === "unavailable",
			};
			return afterSince(sourceMetadata(data, provenance), since)
				? [{ repo, stream, data, provenance }]
				: [];
		});
	});
	const saved = decode(() => assembleSnapshotGroups(rows.results));
	const streamMeta = decode(
		() => new Map(resources.map((row) => [row.kind, decodeContent(row.content_meta)])),
	);
	const activityMeta = decode(
		() =>
			new Map(
				resources
					.filter((row) => row.stream && ACTIVITY_STREAMS.includes(row.stream as ActivityStream))
					.map(
						(row) =>
							[
								`${row.repo_id}:${row.stream}`,
								{
									content: decodeContent(row.content_meta)?.hash ?? null,
									data:
										typeof row.run_id === "string" && typeof row.coverage === "string"
											? {
													runId: row.run_id,
													coverage: JSON.parse(row.coverage) as FactoryCoverage,
													ranges: (row.ranges ? JSON.parse(row.ranges) : []) as FactoryWindow[],
													...(row.has_next === 1 ? { next: row.next ?? null } : {}),
												}
											: null,
								},
							] as const,
					),
			),
	);
	const login = owners.results[0]?.login ?? "";
	const members = decode(() =>
		historyRows.results
			.filter((row) => {
				const slash = row.repo.indexOf("/");
				return slash > 0 && row.repo.slice(0, slash).toLowerCase() === login.toLowerCase();
			})
			.map((row) => ({ id: row.github_id, name: row.repo }))
			.sort((left, right) => {
				const leftName = left.name.toLowerCase();
				const rightName = right.name.toLowerCase();
				return Number(leftName > rightName) - Number(rightName > leftName);
			}),
	);
	const groups = latestSnapshots(saved);
	type Source = {
		resource: string;
		version: string;
		contentVersion: string | null;
		runId: string | null;
		observedAt: string | null;
	} & ReturnType<typeof observationMetadata>;
	const sources: Source[] = [];
	const add = async (
		resource: string,
		data: Record<string, unknown>,
		version: string | undefined = storedContent(data)?.fullVersion,
		content: string | null = storedContent(data)?.hash ?? null,
		publication = data.publication as SourcePublication | undefined,
	) => {
		const metadata = sourceMetadata(data, publication);
		if (!afterSince(metadata, since)) return;
		data = prSnapshot(data);
		return {
			resource,
			version: version ?? (await hash(() => observationVersion(data))),
			contentVersion: content,
			...metadata,
		};
	};
	if (publication) {
		const window = { ...publication.window, gap: true, first: true };
		const evidence = members.map((member) => {
			const published = publication.repos.find((repo) => repo.id === member.id);
			return ACTIVITY_STREAMS.map((stream) =>
				activityEvidenceCoverage(
					stream,
					activityMeta.get(`${member.id}:${stream}`)?.data ?? null,
					published,
					window,
				),
			);
		});
		const times = evidence.map((streams) =>
			streams.map((coverage) => coverage.source?.fetchedAt ?? null),
		);
		const freshness = snapshotFreshness(times.flat());
		freshness.total = times.length;
		freshness.missing = times.filter((values) => snapshotFreshness(values).missing > 0).length;
		const truncated =
			publication.truncated === true ||
			evidence.some((streams) => streams.some((coverage) => coverage.truncated));
		const publishedAt = publication.publication?.publishedAt ?? publication.fetched_at;
		const runId = publication.runId;
		const data = {
			fetched_at: freshness.latestAt,
			freshness,
			coverage: activityCoverageSummary(publication, truncated),
			truncated,
			unavailable: false,
		};
		if (afterSince(sourceMetadata(data, { runId, publishedAt }), since)) {
			const inputs: Record<string, string | null> = {
				publication: storedContent(publication)?.hash ?? null,
			};
			for (const member of members)
				for (const stream of ACTIVITY_STREAMS)
					inputs[`repo:${member.name.toLowerCase()}:${stream}`] =
						activityMeta.get(`${member.id}:${stream}`)?.content ?? "missing";
			const source = await add(
				"account:activity",
				data,
				runId,
				await hash(() =>
					composeContent(inputs, {
						repositories: members.map((member) => member.name),
						truncated,
					}),
				),
				{ runId, publishedAt },
			);
			if (source) sources.push(source);
		}
	}
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
			let provenance: SourcePublication | undefined;
			if (resource === "factory") {
				if (!publication) continue;
				data = projectFactoryObservation(publication, policy);
				version = publication.publication?.runId ?? publication.runId;
			} else if (resource === "ci") {
				const inputs = ciObservationInputs(policy, groups);
				for (const repo of policy.repos)
					for (const suffix of ["actions", "releases", "details"]) {
						const snapshot = groups.get(`repo:${repo.name_with_owner}:${suffix}`.toLowerCase());
						if (!snapshot) continue;
						const metadata = sourceMetadata(snapshot.data);
						if (
							metadata.runId &&
							(!provenance || String(metadata.fetchedAt) > String(provenance.publishedAt))
						)
							provenance = { runId: metadata.runId, publishedAt: metadata.fetchedAt };
					}
				if (!afterSince(sourceMetadata(inputs.metadata, provenance), since)) continue;
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
				provenance,
			);
			if (source) sources.push(source);
		} catch (error) {
			if (!(error instanceof ApiError) || error.code !== "snapshot_missing") throw error;
		}
	}
	const repositories = policy.repos.map((repo) => repo.name_with_owner).sort();
	if (publication)
		for (const { repo, stream, data: metadata, provenance } of streams) {
			const version =
				repo.coverage[stream].observation?.version ??
				repo.observation?.version ??
				publication.runId;
			const meta = streamMeta.get(`stream:${repo.name}:${stream}`);
			const source = await add(
				`factory:${repo.name}:${stream}`,
				metadata,
				version,
				await hash(async () =>
					factoryStreamContent(meta?.version === version ? meta.hash : null, repo.coverage[stream]),
				),
				{ ...provenance, runId: version },
			);
			if (source) sources.push(source);
		}

	return { account_id: account, repositories, sources };
}
