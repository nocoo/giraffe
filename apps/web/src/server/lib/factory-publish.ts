import { mergeMetrics, summarizeEvents } from "../../lib/factory";
import {
	dependencyEvidence,
	dependencyFromEvent,
	normalizeRepoDependencies,
} from "../../lib/factory-dependencies";
import { completedRunStatus, REPO_COOLDOWN_MS, type RepoRefreshState } from "../../lib/factory-run";
import {
	FACTORY_STREAMS,
	type FactoryRepo,
	type FactorySnapshot,
	type FactoryStreamData,
} from "../../lib/factory-types";
import { activityPublicationWrites } from "./activity-store";
import { type CatalogPlan, catalogPlanWrites, catalogSnapshot } from "./catalog-history";
import { savedContentMeta } from "./content-version";
import type { Db } from "./db/d1";
import {
	catalogFactory,
	factoryHead,
	fenced,
	publishedFactory,
	type RunLease,
} from "./db/factory-runs";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { ApiError } from "./errors";
import { streamKey } from "./factory-collect";
import { latestFactoryRate } from "./factory-rate";
import { assemblePages, physicalKinds, splitPages } from "./snapshot-pages";

export function boundedJson(value: unknown): string {
	const text = JSON.stringify(value);
	if (new TextEncoder().encode(text).length > 1_800_000)
		throw new ApiError(
			422,
			"factory_capacity",
			"factory record capacity reached; previous data retained",
		);
	return text;
}
export async function snapshotWrites(
	db: Db,
	lease: RunLease,
	now: string,
	kind: string,
	snapshot: FactorySnapshot,
): Promise<D1PreparedStatement[]> {
	const { pages, truncated } = splitPages(kind, { ...snapshot });
	if (truncated)
		throw new ApiError(
			422,
			"factory_capacity",
			"publication capacity reached; previous data retained",
		);
	const metadata = await savedContentMeta(kind, assemblePages(kind, pages));
	return [
		fenced(
			db,
			lease,
			now,
			"DELETE FROM snapshots WHERE account_id=? AND kind IN (?,?) AND $guard",
			[lease.run.account_id, ...physicalKinds(kind)],
		),
		...pages.map((p) =>
			fenced(
				db,
				lease,
				now,
				"INSERT INTO snapshots(account_id,kind,payload,fetched_at,content_meta) SELECT ?,?,?,?,? WHERE $guard ON CONFLICT(account_id,kind) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at,content_meta=excluded.content_meta",
				[lease.run.account_id, p.kind, p.payload, now, metadata],
			),
		),
	];
}
export async function currentRepo(
	db: Db,
	account: string,
	repo: string,
): Promise<FactoryRepo | null> {
	const result = await db
		.prepare(
			"SELECT v.payload FROM factory_repo_versions v JOIN factory_repo_state s ON s.account_id=v.account_id AND COALESCE(json_extract(s.payload,'$.observation.repo'),s.repo)=v.repo AND s.version=v.version WHERE s.account_id=? AND s.repo=?",
		)
		.bind(account, repo)
		.first<{ payload: string }>();
	if (!result) return null;
	const value = normalizeRepoDependencies(JSON.parse(result.payload) as FactoryRepo);
	return value.name === repo
		? value
		: {
				...value,
				name: repo,
				...(value.observation
					? { observation: { ...value.observation, repo: value.observation.repo ?? value.name } }
					: {}),
			};
}
export async function repositoryWrites(
	db: Db,
	lease: RunLease,
	now: string,
	repo: FactoryRepo | null,
	name: string,
	error: string | null,
	legacy = false,
): Promise<D1PreparedStatement[]> {
	if (repo) repo = normalizeRepoDependencies(repo);
	const previous = await currentRepo(db, lease.run.account_id, name);
	const oldState = await db
		.prepare("SELECT payload FROM factory_repo_state WHERE account_id=? AND repo=?")
		.bind(lease.run.account_id, name)
		.first<{ payload: string }>();
	const old = oldState ? (JSON.parse(oldState.payload) as RepoRefreshState) : null;
	const parseLimited =
		repo?.coverage.dependencies.status === "limited" &&
		repo.coverage.dependencies.reason_code === "dependency_parse_unsupported";
	// An incomplete refresh must never replace a previously complete stream with less evidence.
	const regression =
		repo &&
		previous &&
		FACTORY_STREAMS.some(
			(s) =>
				(s === "dependencies" && parseLimited && previous.coverage[s].status === "limited") ||
				(previous.coverage[s].status === "complete" && repo.coverage[s].status !== "complete") ||
				(previous.coverage[s].status === "limited" &&
					previous.coverage[s].observed > 0 &&
					repo.coverage[s].status !== "complete" &&
					(repo.coverage[s].status !== "limited" ||
						repo.coverage[s].observed < previous.coverage[s].observed)),
		);
	const accepted = error || regression ? null : repo;
	const steps = lease.run.steps.filter((s) => s.repo === name);
	const state: RepoRefreshState = {
		...(!accepted && parseLimited && repo
			? {
					dependencyLimit: {
						reason_code: "dependency_parse_unsupported" as const,
						reason: repo.coverage.dependencies.reason,
					},
				}
			: !accepted && old?.dependencyLimit
				? { dependencyLimit: old.dependencyLimit }
				: {}),
		observation: accepted?.observation ?? old?.observation,
		repo: name,
		version: accepted?.observation?.version ?? old?.version ?? null,
		refreshedAt: accepted?.observation?.refreshedAt ?? old?.refreshedAt ?? null,
		status: error
			? "failed"
			: regression ||
					!accepted ||
					FACTORY_STREAMS.some((s) => accepted.coverage[s].status !== "complete")
				? "partial"
				: "success",
		nextAllowedAt: legacy ? now : new Date(Date.parse(now) + REPO_COOLDOWN_MS).toISOString(),
		attemptedAt: now,
		durationMs: steps.reduce((sum, s) => sum + s.durationMs, 0),
		retries: steps.reduce((sum, s) => sum + Math.max(0, s.attempts - 1), 0),
		error: error ?? (regression ? "coverage_regression_retained" : null),
		coverage: accepted
			? FACTORY_STREAMS.filter((s) => accepted.coverage[s].status === "complete").length
			: (old?.coverage ?? 0),
	};
	const writes: D1PreparedStatement[] = [];
	if (accepted)
		writes.push(
			fenced(
				db,
				lease,
				now,
				"INSERT INTO factory_repo_versions(account_id,repo,version,payload,refreshed_at) SELECT ?,?,?,?,? WHERE $guard ON CONFLICT(account_id,repo,version) DO NOTHING",
				[lease.run.account_id, name, state.version, boundedJson(accepted), state.refreshedAt],
			),
		);
	writes.push(
		fenced(
			db,
			lease,
			now,
			"INSERT INTO factory_repo_state(account_id,repo,version,payload) SELECT ?,?,?,? WHERE $guard ON CONFLICT(account_id,repo) DO UPDATE SET version=excluded.version,payload=excluded.payload",
			[lease.run.account_id, name, state.version, boundedJson(state)],
		),
	);
	return writes;
}
/** Recover only already-stored evidence, preserving its original run window/time. No GitHub calls. */
export async function restoreLegacyRepo(
	db: Db,
	lease: RunLease,
	now: string,
	repo: FactoryRepo,
): Promise<D1PreparedStatement[]> {
	if (await currentRepo(db, lease.run.account_id, repo.name)) return [];
	const publication = await publishedFactory(db, lease.run.account_id);
	const previous = publication?.repos.find(
		(observed) => observed.name.toLowerCase() === repo.name.toLowerCase(),
	);
	if (previous?.id && previous.id !== repo.id) return [];
	const resources = new Map<string, FactoryStreamData>();
	for (const stream of FACTORY_STREAMS) {
		const data = (await readSnapshot(
			db,
			lease.run.account_id,
			streamKey(repo.name, stream),
		)) as FactoryStreamData | null;
		if (data?.coverage && Array.isArray(data.items)) resources.set(stream, data);
	}
	const first = [...resources.values()].find((d) => Number.isFinite(Date.parse(d.runId)));
	if (!first) return [];
	const boundWindow = (observed: FactoryRepo | undefined, root?: FactorySnapshot | null) => {
		if (
			!observed ||
			!repo.id ||
			observed.id !== repo.id ||
			(observed.observation?.repo ?? observed.name) !== repo.name ||
			(observed.observation?.version ?? root?.runId) !== first.runId ||
			(observed.observation?.source ?? (root ? "legacy" : null)) !== "legacy"
		)
			return null;
		const window = observed.observation ? observed.observation.window : root?.window;
		return window && Date.parse(window.since) < Date.parse(window.until) ? window : null;
	};
	let window = boundWindow(previous, publication);
	if (!window) {
		const legacy = (await readSnapshot(
			db,
			lease.run.account_id,
			"factory",
		)) as FactorySnapshot | null;
		window = boundWindow(
			legacy?.repos.find((observed) => (observed.observation?.repo ?? observed.name) === repo.name),
			legacy,
		);
	}
	if (!window) {
		const saved = await db
			.prepare(
				"SELECT payload FROM factory_repo_versions WHERE account_id=? AND repo=? AND version=?",
			)
			.bind(lease.run.account_id, repo.name, first.runId)
			.first<{ payload: string }>();
		window = boundWindow(saved ? (JSON.parse(saved.payload) as FactoryRepo) : undefined);
	}
	if (!window) return [];
	// Bind the original logical keys, not URLs, to avoid confusing issues with PRs or GraphQL manifests.
	for (const stream of FACTORY_STREAMS) {
		const data = resources.get(stream);
		if (!data?.coverage || data.runId !== first.runId || !Array.isArray(data.items)) continue;
		repo.coverage[stream] = data.coverage;
		if (data.coverage.status !== "partial" && data.coverage.status !== "pending")
			repo.metrics = mergeMetrics([repo.metrics, summarizeEvents(stream, data.items, window)]);
		if (stream === "dependencies") {
			const evidence = dependencyEvidence(data.items, data.manifests);
			repo.dependencies = evidence.items.map(dependencyFromEvent);
			repo.manifests = evidence.manifests;
		}
	}
	repo.observation = {
		version: first.runId,
		window,
		refreshedAt:
			[...resources.values()]
				.filter((data) => data.runId === first.runId)
				.map((d) => d.coverage.fetchedAt ?? first.runId)
				.sort()
				.at(-1) ?? first.runId,
		source: "legacy",
		repo: repo.name,
		metadataAt: repo.metadataAt ?? lease.run.startedAt,
	};
	return repositoryWrites(db, lease, now, repo, repo.name, null, true);
}
export async function publicationWrites(
	db: Db,
	lease: RunLease,
	now: string,
): Promise<D1PreparedStatement[]> {
	const run = lease.run;
	const base = await publishedFactory(db, run.account_id);
	const head = await factoryHead(db, run.account_id);
	const writes: D1PreparedStatement[] = [];
	const staged = await db
		.prepare(
			"SELECT payload FROM factory_resources WHERE run_id=? AND repo='' AND stream='catalog-plan'",
		)
		.bind(run.id)
		.first<{ payload: string }>();
	let discovery: CatalogPlan | null = null;
	if (staged && run.steps.some((step) => step.resource === "repos" && step.status === "success")) {
		discovery = JSON.parse(staged.payload) as CatalogPlan;
		writes.push(...catalogPlanWrites(db, run.account_id, discovery));
		writes.push(
			...(await replaceSnapshotStmts(
				db,
				run.account_id,
				"repos",
				catalogSnapshot(discovery),
				discovery.at,
			)),
		);
		if (discovery.warning) run.error = discovery.warning;
		if (run.mode === "catalog" && run.checkpoint?.inventory.complete) {
			const previous = await catalogFactory(db, run.account_id);
			const metadata = new Map(
				[...(previous?.repos ?? []), ...run.checkpoint.repos].map((repo) => [repo.id, repo]),
			);
			run.checkpoint.repos = discovery.rows
				.filter(
					(row) =>
						!row.removed_at && row.repo.split("/")[0]?.toLowerCase() === run.owner.toLowerCase(),
				)
				.map((row) => {
					const repo =
						(row.github_id ? metadata.get(row.github_id) : null) ??
						previous?.repos.find((repo) => repo.name.toLowerCase() === row.repo.toLowerCase());
					if (!repo)
						throw new ApiError(
							409,
							"catalog_incomplete",
							"Retained repository metadata is unavailable",
						);
					return { ...repo, name: row.repo };
				});
		}
	}
	if (run.mode === "catalog" && run.checkpoint) {
		if (!discovery || !run.checkpoint.inventory.complete)
			throw new ApiError(409, "catalog_incomplete", "Catalog completion evidence is unavailable");
		writes.push(
			...(await snapshotWrites(db, lease, now, `factory:catalog:${run.id}`, run.checkpoint)),
		);
		writes.push(
			fenced(
				db,
				lease,
				now,
				"UPDATE factory_state SET catalog_id=? WHERE account_id=? AND $guard",
				[run.id, run.account_id],
			),
		);
		if (head?.published_id) return writes;
	}
	const snapshot = structuredClone(run.mode === "catalog" ? run.checkpoint : base);
	if (!snapshot)
		throw new ApiError(409, "snapshot_missing", "no catalog or committed factory data");
	const result = await db
		.prepare(
			"SELECT v.payload,s.payload AS state FROM factory_repo_versions v JOIN factory_repo_state s ON s.account_id=v.account_id AND COALESCE(json_extract(s.payload,'$.observation.repo'),s.repo)=v.repo AND s.version=v.version WHERE v.account_id=? ORDER BY v.refreshed_at,v.repo",
		)
		.bind(run.account_id)
		.all<{ payload: string; state: string }>();
	const committed = result.results.map((r) => {
		const repo = normalizeRepoDependencies(JSON.parse(r.payload) as FactoryRepo);
		const state = JSON.parse(r.state) as RepoRefreshState;
		if (state.dependencyLimit)
			repo.coverage.dependencies = {
				...repo.coverage.dependencies,
				...state.dependencyLimit,
				status: "limited",
				retained: true,
			};
		return repo;
	});
	for (const old of snapshot.repos) {
		if (!old.observation)
			old.observation = {
				version: snapshot.runId,
				window: snapshot.window,
				refreshedAt: snapshot.fetched_at,
				source: "legacy",
			};
	}
	const map = new Map(snapshot.repos.map((r) => [r.id, r]));
	for (const repo of committed) map.set(repo.id, repo);
	const catalog =
		run.mode === "catalog" ? run.checkpoint : await catalogFactory(db, run.account_id);
	if (catalog?.inventory.complete) {
		snapshot.inventory = catalog.inventory;
		snapshot.repos = catalog.repos.map((meta) => {
			const observed = map.get(meta.id);
			if (!observed) return meta;
			if (observed.observation?.version === run.id) return observed;
			return {
				...observed,
				name: meta.name,
				url: meta.url,
				...(observed.observation
					? {
							observation: {
								...observed.observation,
								repo: observed.observation.repo ?? observed.name,
							},
						}
					: {}),
			};
		});
	} else snapshot.repos = [...map.values()];
	snapshot.runId = run.id;
	snapshot.status = completedRunStatus(run) === "completed" ? "complete" : "partial";
	snapshot.fetched_at = now;
	snapshot.startedAt = run.startedAt;
	snapshot.window = run.window;
	snapshot.requests = run.requests;
	snapshot.rate = latestFactoryRate(base?.rate, run.checkpoint?.rate);
	const fresh =
		run.mode === "refresh" && run.checkpoint?.contributionStatus === "complete"
			? run.checkpoint.contribution
			: null;
	snapshot.contribution = fresh ?? base?.contribution ?? null;
	snapshot.contributionStatus = !run.steps.some((step) => step.kind === "contributions")
		? (base?.contributionStatus ?? "unavailable")
		: fresh
			? "complete"
			: "unavailable";
	if (fresh)
		snapshot.contributionObservation = {
			version: run.id,
			window: run.window,
			fetchedAt: fresh.fetchedAt,
		};
	else if (base?.contribution)
		snapshot.contributionObservation = base.contributionObservation ?? {
			version: base.runId,
			window: base.window,
			fetchedAt: base.contribution.fetchedAt,
		};
	snapshot.publication = {
		mixed:
			snapshot.repos.some((r) => r.observation?.version !== run.id) ||
			Boolean(snapshot.contribution && snapshot.contributionObservation?.version !== run.id),
		runId: run.id,
		publishedAt: now,
	};
	const refs = snapshot.repos.flatMap((repo) =>
		repo.observation
			? [
					{
						repo: repo.observation.repo ?? repo.name,
						version: repo.observation.version,
						source: repo.observation.source,
					},
				]
			: [],
	);
	writes.push(
		fenced(
			db,
			lease,
			now,
			"INSERT INTO factory_version_refs(account_id,publication_id,repo,version,source) SELECT ?,?,json_extract(value,'$.repo'),json_extract(value,'$.version'),json_extract(value,'$.source') FROM json_each(?) WHERE $guard ON CONFLICT(account_id,publication_id,repo) DO NOTHING",
			[run.account_id, run.id, JSON.stringify(refs)],
		),
	);
	writes.push(...(await snapshotWrites(db, lease, now, `factory:v:${run.id}`, snapshot)));
	writes.push(...(await activityPublicationWrites(db, lease, now, snapshot.repos)));
	writes.push(
		fenced(
			db,
			lease,
			now,
			"UPDATE factory_state SET published_id=? WHERE account_id=? AND $guard",
			[run.id, run.account_id],
		),
	);
	return writes;
}
