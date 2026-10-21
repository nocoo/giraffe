import { type CiEntry, type CiRelease, type CiRun, ciReport } from "../../lib/ci-health";
import { dependencyEvidence } from "../../lib/factory-dependencies";
import type {
	FactoryRepo,
	FactorySnapshot,
	FactoryStreamData,
	FactoryStreamName,
} from "../../lib/factory-types";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import { prSnapshot, prState } from "../../lib/pull-request";
import { snapshotFreshness } from "../../lib/snapshot-freshness";
import {
	composeContent,
	decodeContent,
	observationVersion,
	storedContent,
} from "./content-version";
import type { Db } from "./db/d1";
import { publishedFactory } from "./db/factory-runs";
import { readRepositorySnapshot, readSnapshot } from "./db/snapshots";
import { ApiError } from "./errors";
import { streamKey } from "./factory-collect";
import {
	factoryFreshness,
	type Policy,
	projectSnapshot,
	repoPolicy,
	statisticsFactory,
} from "./repo-statistics";
import { latestSnapshotGroups, type SnapshotPage } from "./snapshot-pages";
import type { SnapshotScope } from "./snapshot-scope";

export async function requireCatalogRepo(db: Db, account: string, name: string) {
	const policy = await repoPolicy(db, account);
	const repo = policy.repos.find((r) => r.name_with_owner.toLowerCase() === name.toLowerCase());
	if (!repo) throw new ApiError(404, "not_found", "repository outside saved account catalog");
	return repo.name_with_owner;
}
export { observationVersion };
export async function observationEnvelope(
	account: string,
	resource: string,
	data: Record<string, unknown>,
	scope: SnapshotScope = "all",
	publicationId: string | null = null,
	version: string | undefined = storedContent(data)?.fullVersion,
	content: string | null = storedContent(data)?.hash ?? null,
) {
	data = prSnapshot(data);
	return {
		account_id: account,
		data,
		sourceVersion: version ?? (await observationVersion(data)),
		contentVersion: content,
		...observationMetadata(data),
		source: { kind: publicationId ? "factory" : "snapshot", resource, publicationId },
		selection: { scope, statisticsFilter: false },
	};
}

export function observationMetadata(data: Record<string, unknown>) {
	const fetchedAt = typeof data.fetched_at === "string" ? data.fetched_at : null;
	const times =
		data.repository_fetched_at && typeof data.repository_fetched_at === "object"
			? Object.values(data.repository_fetched_at).map((v) => (typeof v === "string" ? v : null))
			: [fetchedAt];
	return {
		fetchedAt,
		freshness: data.freshness ?? snapshotFreshness(times),
		coverage: data.coverage ?? null,
		truncated: data.truncated === true,
		unavailable: data.unavailable === true || data.forbidden === true,
	};
}
export async function readCiObservation(
	db: Db,
	account: string,
	policy: Policy,
	statisticsFilter = false,
) {
	return projectCiObservation(policy, await readCiGroups(db, account), statisticsFilter);
}

async function readCiGroups(db: Db, account: string) {
	// One statement for every repository keeps the Worker well inside the D1 statement cap.
	const rows = await db
		.prepare(
			"SELECT kind, payload, fetched_at, content_meta FROM snapshots WHERE account_id=? AND kind LIKE 'repo:%' AND (kind LIKE '%:actions' OR kind LIKE '%:actions#2' OR kind LIKE '%:releases' OR kind LIKE '%:releases#2' OR kind LIKE '%:details' OR kind LIKE '%:details#2')",
		)
		.bind(account)
		.all<SnapshotPage & { fetched_at: string }>();
	return latestSnapshotGroups(rows.results);
}

export function ciContent(policy: Policy, groups: ReturnType<typeof latestSnapshotGroups>) {
	const inputs: Record<string, string | null> = {
		catalog: storedContent(policy.catalog)?.hash ?? null,
	};
	for (const repo of policy.repos)
		for (const suffix of ["actions", "releases", "details"]) {
			const key = `repo:${repo.name_with_owner}:${suffix}`.toLowerCase();
			const data = groups.get(key)?.data;
			inputs[key] = data ? (storedContent(data)?.hash ?? null) : "missing";
		}
	return composeContent(inputs);
}

export function factoryContent(snapshot: FactorySnapshot, policy: Policy) {
	return composeContent(
		{
			publication: storedContent(snapshot)?.hash ?? null,
			catalog: storedContent(policy.catalog)?.hash ?? null,
		},
		{ repositories: policy.repos.map((repo) => repo.name_with_owner), scope: policy.scope },
	);
}

export function ciObservationInputs(
	policy: Policy,
	groups: ReturnType<typeof latestSnapshotGroups>,
	statisticsFilter = false,
) {
	if (!policy.catalog && !policy.empty)
		throw new ApiError(409, "snapshot_missing", "no repository catalog");
	const entries: CiEntry[] = [];
	const unsaved: string[] = [];
	const times: (string | null)[] = [];
	let truncated = false;
	for (const repo of policy.repos) {
		const name = repo.name_with_owner;
		if (statisticsFilter && !policy.enabled(name)) continue;
		const read = (suffix: string) => groups.get(`repo:${name}:${suffix}`.toLowerCase())?.data;
		const actions = read("actions");
		const releases = read("releases");
		const details = read("details");
		const limited = [actions, releases, details].some((snapshot) => snapshot?.truncated === true);
		truncated ||= limited;
		const dependencies = [actions, releases, details].map((snapshot) =>
			snapshot?.unavailable !== true &&
			snapshot?.forbidden !== true &&
			typeof snapshot?.fetched_at === "string"
				? snapshot.fetched_at
				: null,
		);
		times.push(...dependencies);
		if (!actions || actions.unavailable === true || actions.forbidden === true) {
			unsaved.push(name);
			continue;
		}
		entries.push({
			repo: name,
			fetched_at: snapshotFreshness(dependencies).latestAt ?? "",
			truncated: limited,
			runs: Array.isArray(actions.runs) ? (actions.runs as CiRun[]) : [],
			...(details?.unavailable !== true &&
			details?.forbidden !== true &&
			typeof details?.default_branch === "string"
				? { default_branch: details.default_branch }
				: {}),
			releases:
				releases?.unavailable !== true &&
				releases?.forbidden !== true &&
				Array.isArray(releases?.releases)
					? (releases.releases as CiRelease[])
					: null,
		});
	}
	const freshness = snapshotFreshness(times);
	const fetchedAt = freshness.latestAt ?? "";
	return {
		entries,
		metadata: { fetched_at: fetchedAt, freshness, truncated, now: fetchedAt, unsaved },
	};
}

export function projectCiInputs({ entries, metadata }: ReturnType<typeof ciObservationInputs>) {
	const fetchedAt = metadata.fetched_at;
	const report = ciReport(entries, fetchedAt || "1970-01-01T00:00:00.000Z");
	return { ...report, daily: fetchedAt ? report.daily : [], ...metadata };
}

export function projectCiObservation(
	policy: Policy,
	groups: ReturnType<typeof latestSnapshotGroups>,
	statisticsFilter = false,
) {
	return projectCiInputs(ciObservationInputs(policy, groups, statisticsFilter));
}

export function projectFactoryObservation(snapshot: FactorySnapshot, policy: Policy) {
	const projected = statisticsFactory(snapshot, policy, false);
	const freshness = factoryFreshness(projected, policy, false);
	return { ...projected, fetched_at: freshness.latestAt ?? "", freshness };
}

export async function readObservation(
	db: Db,
	account: string,
	resource: string,
	scope: SnapshotScope,
	savedPolicy?: Policy,
) {
	const policy = savedPolicy ?? (await repoPolicy(db, account, undefined, scope));
	if (resource.startsWith("repo:")) {
		const snapshot = await readRepositorySnapshot(db, account, resource);
		if (!snapshot) throw new ApiError(409, "snapshot_missing", "no saved source");
		return observationEnvelope(account, snapshot.resource, snapshot.data, scope);
	}
	if (resource === "factory") {
		const snapshot = await publishedFactory(db, account);
		if (!snapshot) throw new ApiError(409, "snapshot_missing", "no saved publication");
		return observationEnvelope(
			account,
			resource,
			projectFactoryObservation(snapshot, policy),
			scope,
			snapshot.publication?.runId ?? snapshot.runId,
			snapshot.publication?.runId ?? snapshot.runId,
			await factoryContent(snapshot, policy),
		);
	}
	if (resource === "ci") {
		const groups = await readCiGroups(db, account);
		return observationEnvelope(
			account,
			resource,
			projectCiObservation(policy, groups),
			scope,
			null,
			undefined,
			await ciContent(policy, groups),
		);
	}
	const snapshot = await readSnapshot(db, account, resource);
	if (!snapshot) throw new ApiError(409, "snapshot_missing", "no saved source");
	const data = await projectSnapshot(db, account, resource, snapshot, policy, false);
	return observationEnvelope(account, resource, data, scope);
}
export async function readFactoryResource(db: Db, account: string, name: string, stream: string) {
	if (!FACTORY_STREAMS.includes(stream as FactoryStreamName))
		throw new ApiError(400, "validation_failed", "unknown stream");
	const snap = await publishedFactory(db, account);
	const repo = snap?.repos.find((r) => r.name.toLowerCase() === name.toLowerCase());
	if (!snap || !repo) throw new ApiError(404, "not_found", "repository outside publication");
	const observation = repo.observation;
	const version = observation?.version ?? snap.runId;
	const original = observation?.repo ?? repo.name;
	let data: FactoryStreamData | null = null;
	let content: string | null = null;
	if (observation?.source === "run") {
		const row = await db
			.prepare(
				"SELECT payload,content_meta FROM factory_resources WHERE run_id=? AND repo=? AND stream=? AND EXISTS(SELECT 1 FROM factory_runs WHERE id=? AND account_id=?)",
			)
			.bind(version, original, stream, version, account)
			.first<{ payload: string; content_meta: string | null }>();
		data = row ? (JSON.parse(row.payload) as FactoryStreamData) : null;
		const meta = decodeContent(row?.content_meta);
		content = meta?.version === version ? meta.hash : null;
	} else {
		data = (await readSnapshot(
			db,
			account,
			streamKey(original, stream as FactoryStreamName),
		)) as FactoryStreamData | null;
		const meta = storedContent(data);
		content = meta?.version === version ? meta.hash : null;
	}
	if (!data)
		throw new ApiError(
			409,
			"snapshot_missing",
			"immutable source missing; refresh this repository",
		);
	if (data.runId !== version)
		throw new ApiError(
			409,
			"snapshot_missing",
			"immutable source version mismatch; refresh this repository",
		);
	return observationEnvelope(
		account,
		`factory:${repo.name}:${stream}`,
		factoryResourceData(snap, repo, stream, data),
		"all",
		snap.publication?.runId ?? snap.runId,
		version,
		content,
	);
}

export function factoryResourceData(
	snap: FactorySnapshot,
	repo: FactoryRepo,
	stream: string,
	data: FactoryStreamData,
) {
	return {
		...data,
		...(stream === "prs"
			? { items: data.items.map((item) => ({ ...item, ...prState(item) })) }
			: {}),
		...(stream === "dependencies"
			? dependencyEvidence(data.items, [...(repo.manifests ?? []), ...(data.manifests ?? [])])
			: {}),
		ranges: [repo.observation?.window ?? snap.window],
		fetched_at: data.coverage.fetchedAt,
		observation: repo.observation,
		coverage: data.coverage,
		truncated: data.coverage.status === "limited",
		unavailable: data.coverage.status === "unavailable",
	};
}
