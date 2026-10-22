import { type CiEntry, type CiRelease, type CiRun, ciReport } from "../../lib/ci-health";
import { dependencyEvidence } from "../../lib/factory-dependencies";
import type {
	FactoryRepo,
	FactorySnapshot,
	FactoryStreamData,
	FactoryStreamName,
} from "../../lib/factory-types";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import { prLifecycleState, prSnapshot, prState } from "../../lib/pull-request";
import { snapshotFreshness } from "../../lib/snapshot-freshness";
import {
	composeContent,
	factoryStreamContent,
	observationVersion,
	storedContent,
} from "./content-version";
import type { Db } from "./db/d1";
import { publishedFactory } from "./db/factory-runs";
import { readRepositorySnapshot, readSnapshot, snapshotFromRows } from "./db/snapshots";
import { ApiError } from "./errors";
import { factoryRateFromRow } from "./factory-rate";
import {
	accountReadPlan,
	decodePublication,
	type PublicationPage,
	type SavedAccountRead,
	savedAccountPolicy,
} from "./saved-observation-read";
import type { AccountObservationResource } from "./saved-observation-statements";
import {
	decodeFactoryResource,
	factoryStreamReadPlan,
	repositoryReadPlan,
	type SavedFactoryStream,
} from "./saved-repository-read";
import { assembleSnapshotGroups, latestSnapshotGroups, type SnapshotPage } from "./snapshot-pages";
import {
	factoryFreshness,
	factoryObserved,
	type Policy,
	projectFactory,
	projectSnapshot,
	repoPolicy,
} from "./snapshot-projection";
import type { SnapshotScope } from "./snapshot-scope";

export async function requireCatalogRepo(db: Db, account: string, name: string) {
	const snapshot = await readSnapshot(db, account, "repos");
	return catalogRepository(snapshot, name);
}

function catalogRepository(snapshot: Record<string, unknown> | null, name: string): string {
	const repo = (Array.isArray(snapshot?.repos) ? snapshot.repos : []).find(
		(row) =>
			typeof row?.name_with_owner === "string" &&
			row.name_with_owner.toLowerCase() === name.toLowerCase(),
	);
	if (!repo) throw new ApiError(404, "not_found", "repository outside saved account catalog");
	return repo.name_with_owner;
}

export async function readMachineRepositoryObservation(
	db: Db,
	account: string,
	name: string,
	tab: string,
) {
	const plan = repositoryReadPlan(db, account, name, tab);
	const saved = plan.decode(await db.batch<SnapshotPage>(plan.statements));
	const canonical = catalogRepository(snapshotFromRows("repos", saved.catalogPages), name);
	const snapshot = latestSnapshotGroups(saved.pages).get(`repo:${canonical}:${tab}`.toLowerCase());
	if (!snapshot) throw new ApiError(409, "snapshot_missing", "no saved source");
	return observationEnvelope(account, snapshot.resource, snapshot.data, "all");
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
	const sourceVersion = version ?? (await observationVersion(prSnapshot(data)));
	data = prSnapshot(data, { lifecycle: true });
	return {
		account_id: account,
		data,
		sourceVersion,
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
export async function readCiObservation(db: Db, account: string, policy: Policy) {
	return projectCiObservation(policy, await readCiGroups(db, account));
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

export function ciContent(
	policy: Policy,
	groups: ReturnType<typeof latestSnapshotGroups>,
	freshness: ReturnType<typeof snapshotFreshness>,
) {
	const inputs: Record<string, string | null> = {
		catalog: storedContent(policy.catalog)?.hash ?? null,
	};
	for (const repo of policy.repos)
		for (const suffix of ["actions", "releases", "details"]) {
			const key = `repo:${repo.name_with_owner}:${suffix}`.toLowerCase();
			const data = groups.get(key)?.data;
			inputs[key] = data ? (storedContent(data)?.hash ?? null) : "missing";
		}
	return composeContent(inputs, { total: freshness.total, missing: freshness.missing });
}

export function factoryContent(snapshot: FactorySnapshot, policy: Policy) {
	const freshness = factoryFreshness(snapshot, policy);
	return composeContent(
		{
			publication: storedContent(snapshot)?.hash ?? null,
			catalog: storedContent(policy.catalog)?.hash ?? null,
		},
		{
			repositories: policy.repos.map((repo) => repo.name_with_owner),
			observed: factoryObserved(snapshot, policy).map((repo) => repo.name),
			scope: policy.scope,
			total: freshness.total,
			missing: freshness.missing,
			truncated: snapshot.truncated === true || snapshot.inventory.complete !== true,
		},
	);
}

export function ciObservationInputs(
	policy: Policy,
	groups: ReturnType<typeof latestSnapshotGroups>,
) {
	if (!policy.catalog && !policy.empty)
		throw new ApiError(409, "snapshot_missing", "no repository catalog");
	const entries: CiEntry[] = [];
	const unsaved: string[] = [];
	const times: (string | null)[] = [];
	let missing = 0;
	let truncated = false;
	for (const repo of policy.repos) {
		const name = repo.name_with_owner;
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
		if (snapshotFreshness(dependencies).missing > 0) missing++;
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
	freshness.total = policy.repos.length;
	freshness.missing = missing;
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
) {
	return projectCiInputs(ciObservationInputs(policy, groups));
}

export function projectFactoryObservation(snapshot: FactorySnapshot, policy: Policy) {
	const projected = projectFactory(snapshot, policy);
	const freshness = factoryFreshness(projected, policy);
	return {
		...projected,
		fetched_at: freshness.latestAt ?? "",
		freshness,
		truncated:
			projected.truncated === true ||
			projected.inventory.complete !== true ||
			freshness.missing > 0,
	};
}

export async function readObservation(
	db: Db,
	account: string,
	resource: string,
	scope: SnapshotScope,
	savedPolicy?: Policy,
) {
	const plan =
		!savedPolicy && ["repos", "issues", "prs", "ci", "factory"].includes(resource)
			? accountReadPlan(db, account, resource as AccountObservationResource, scope)
			: null;
	const saved = plan ? plan.decode(await db.batch(plan.statements)) : undefined;
	return projectObservation(db, account, resource, scope, savedPolicy, saved);
}

export async function readMachineAccountObservation(
	db: Db,
	account: string,
	resource: AccountObservationResource,
	scope: SnapshotScope,
) {
	const plan = accountReadPlan(db, account, resource, scope, { rate: true });
	const saved = plan.decode(await db.batch(plan.statements));
	const observation = await projectObservation(db, account, resource, scope, undefined, saved);
	if (resource === "factory")
		observation.data.rate = factoryRateFromRow(
			saved.rateRows[0] ?? null,
			observation.data.rate as FactorySnapshot["rate"],
		);
	return observation;
}

async function projectObservation(
	db: Db,
	account: string,
	resource: string,
	scope: SnapshotScope,
	savedPolicy?: Policy,
	saved?: SavedAccountRead,
) {
	const policy =
		savedPolicy ??
		(saved ? savedAccountPolicy(saved, scope) : await repoPolicy(db, account, undefined, scope));
	if (resource.startsWith("repo:")) {
		const snapshot = await readRepositorySnapshot(db, account, resource);
		if (!snapshot) throw new ApiError(409, "snapshot_missing", "no saved source");
		return observationEnvelope(account, snapshot.resource, snapshot.data, scope);
	}
	if (resource === "factory") {
		const snapshot = saved
			? decodePublication(saved.sourcePages as PublicationPage[])
			: await publishedFactory(db, account);
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
		const groups = saved ? latestSnapshotGroups(saved.ciPages) : await readCiGroups(db, account);
		const data = projectCiObservation(policy, groups);
		return observationEnvelope(
			account,
			resource,
			data,
			scope,
			null,
			undefined,
			await ciContent(policy, groups, data.freshness),
		);
	}
	const snapshot = saved
		? resource === "repos"
			? policy.catalog
			: snapshotFromRows(resource, saved.sourcePages)
		: await readSnapshot(db, account, resource);
	if (!snapshot) throw new ApiError(409, "snapshot_missing", "no saved source");
	const data = await projectSnapshot(
		db,
		account,
		resource,
		snapshot,
		policy,
		saved ? () => assembleSnapshotGroups(saved.repositoryPages) : undefined,
	);
	return observationEnvelope(account, resource, data, scope);
}
export async function readFactoryResource(db: Db, account: string, name: string, stream: string) {
	if (!FACTORY_STREAMS.includes(stream as FactoryStreamName))
		throw new ApiError(400, "validation_failed", "unknown stream");
	const plan = factoryStreamReadPlan(db, account, name, stream);
	return factoryObservationFromSaved(
		account,
		name,
		stream,
		plan.decode(await db.batch(plan.statements)),
	);
}

export async function readMachineFactoryStream(
	db: Db,
	account: string,
	name: string,
	stream: string,
) {
	const plan = factoryStreamReadPlan(db, account, name, stream, { catalog: true });
	const saved = plan.decode(await db.batch(plan.statements));
	const canonical = catalogRepository(snapshotFromRows("repos", saved.catalogPages), name);
	if (!FACTORY_STREAMS.includes(stream as FactoryStreamName))
		throw new ApiError(400, "validation_failed", "unknown stream");
	return factoryObservationFromSaved(account, canonical, stream, saved);
}

async function factoryObservationFromSaved(
	account: string,
	name: string,
	stream: string,
	saved: SavedFactoryStream,
) {
	const snap = decodePublication(saved.publicationPages);
	const repo = snap?.repos.find((r) => r.name.toLowerCase() === name.toLowerCase());
	if (!snap || !repo) throw new ApiError(404, "not_found", "repository outside publication");
	const observation = repo.observation;
	const version = observation?.version ?? snap.runId;
	const { data, content } = decodeFactoryResource(saved, snap, repo, stream, true);
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
		await factoryStreamContent(content, repo.coverage[stream as FactoryStreamName]),
	);
}

export function factoryResourceData(
	snap: FactorySnapshot,
	repo: FactoryRepo,
	stream: string,
	data: FactoryStreamData,
) {
	const coverage = repo.coverage[stream as FactoryStreamName].retained
		? repo.coverage[stream as FactoryStreamName]
		: data.coverage;
	return {
		...data,
		...(stream === "prs"
			? {
					items: data.items.map((item) => ({
						...item,
						state: prLifecycleState(item),
						...prState(item),
					})),
				}
			: {}),
		...(stream === "dependencies"
			? dependencyEvidence(data.items, [...(repo.manifests ?? []), ...(data.manifests ?? [])])
			: {}),
		ranges: [repo.observation?.window ?? snap.window],
		fetched_at: coverage.fetchedAt,
		observation: repo.observation,
		coverage,
		truncated: coverage.status === "limited",
		unavailable: coverage.status === "unavailable",
	};
}
