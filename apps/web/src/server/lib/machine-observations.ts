import { type CiEntry, type CiRelease, type CiRun, ciReport } from "../../lib/ci-health";
import type { FactoryStreamData, FactoryStreamName } from "../../lib/factory-types";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import { snapshotFreshness } from "../../lib/snapshot-freshness";
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
async function digest(data: unknown) {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(data)),
	);
	return `sha256:${Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
export async function observationEnvelope(
	account: string,
	resource: string,
	data: Record<string, unknown>,
	scope: SnapshotScope = "all",
	publicationId: string | null = null,
	version?: string,
) {
	const fetchedAt = typeof data.fetched_at === "string" ? data.fetched_at : null;
	const times =
		data.repository_fetched_at && typeof data.repository_fetched_at === "object"
			? Object.values(data.repository_fetched_at).map((v) => (typeof v === "string" ? v : null))
			: [fetchedAt];
	return {
		account_id: account,
		data,
		sourceVersion: version ?? (await digest(data)),
		fetchedAt,
		freshness: data.freshness ?? snapshotFreshness(times),
		coverage: data.coverage ?? null,
		truncated: data.truncated === true,
		unavailable: data.unavailable === true || data.forbidden === true,
		source: { kind: publicationId ? "factory" : "snapshot", resource, publicationId },
		selection: { scope, statisticsFilter: false },
	};
}
export async function readCiObservation(
	db: Db,
	account: string,
	policy: Policy,
	statisticsFilter = false,
) {
	if (!policy.catalog && !policy.empty)
		throw new ApiError(409, "snapshot_missing", "no repository catalog");
	// One statement for every repository keeps the Worker well inside the D1 statement cap.
	const rows = await db
		.prepare(
			"SELECT kind, payload, fetched_at FROM snapshots WHERE account_id=? AND kind LIKE 'repo:%' AND (kind LIKE '%:actions' OR kind LIKE '%:actions#2' OR kind LIKE '%:releases' OR kind LIKE '%:releases#2' OR kind LIKE '%:details' OR kind LIKE '%:details#2')",
		)
		.bind(account)
		.all<SnapshotPage & { fetched_at: string }>();
	const groups = latestSnapshotGroups(rows.results);
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
	const report = ciReport(entries, fetchedAt || "1970-01-01T00:00:00.000Z");
	return {
		...report,
		daily: fetchedAt ? report.daily : [],
		fetched_at: fetchedAt,
		freshness,
		truncated,
		now: fetchedAt,
		unsaved,
	};
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
		const projected = statisticsFactory(snapshot, policy, false);
		const freshness = factoryFreshness(projected, policy, false);
		return observationEnvelope(
			account,
			resource,
			{
				...projected,
				fetched_at: freshness.latestAt ?? "",
				freshness,
			},
			scope,
			snapshot.publication?.runId ?? snapshot.runId,
			snapshot.publication?.runId ?? snapshot.runId,
		);
	}
	if (resource === "ci")
		return observationEnvelope(
			account,
			resource,
			await readCiObservation(db, account, policy),
			scope,
		);
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
	if (observation?.source === "run") {
		const row = await db
			.prepare(
				"SELECT payload FROM factory_resources WHERE run_id=? AND repo=? AND stream=? AND EXISTS(SELECT 1 FROM factory_runs WHERE id=? AND account_id=?)",
			)
			.bind(version, original, stream, version, account)
			.first<{ payload: string }>();
		data = row ? (JSON.parse(row.payload) as FactoryStreamData) : null;
	} else
		data = (await readSnapshot(
			db,
			account,
			streamKey(original, stream as FactoryStreamName),
		)) as FactoryStreamData | null;
	if (!data || data.runId !== version)
		throw new ApiError(409, "snapshot_missing", "immutable source unavailable");
	return observationEnvelope(
		account,
		`factory:${repo.name}:${stream}`,
		{
			...data,
			ranges: [observation?.window ?? snap.window],
			fetched_at: data.coverage.fetchedAt,
			observation,
			coverage: data.coverage,
			truncated: data.coverage.status === "limited",
			unavailable: data.coverage.status === "unavailable",
		},
		"all",
		snap.publication?.runId ?? snap.runId,
		version,
	);
}
