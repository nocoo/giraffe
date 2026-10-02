import { type CiEntry, ciReport } from "../../lib/ci-health";
import type { FactoryStreamData, FactoryStreamName } from "../../lib/factory-types";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import { snapshotFreshness } from "../../lib/snapshot-freshness";
import type { Db } from "./db/d1";
import { publishedFactory } from "./db/factory-runs";
import { readSnapshot } from "./db/snapshots";
import { ApiError } from "./errors";
import { streamKey } from "./factory-collect";
import { repoPolicy } from "./repo-statistics";
import { assemblePages, type SnapshotPage } from "./snapshot-pages";
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
export async function readObservation(
	db: Db,
	account: string,
	resource: string,
	scope: SnapshotScope,
) {
	const policy = await repoPolicy(db, account, undefined, scope);
	if (resource === "factory") {
		const snapshot = await publishedFactory(db, account);
		if (!snapshot) throw new ApiError(409, "snapshot_missing", "no saved publication");
		const repos = snapshot.repos.filter((repo) => policy.includes(repo.name));
		return observationEnvelope(
			account,
			resource,
			{
				...snapshot,
				repos,
				freshness: snapshotFreshness(repos.map((r) => r.observation?.refreshedAt)),
			},
			scope,
			snapshot.publication?.runId ?? snapshot.runId,
			snapshot.publication?.runId ?? snapshot.runId,
		);
	}
	if (resource === "ci") {
		const rows = await db
			.prepare(
				"SELECT kind,payload FROM snapshots WHERE account_id=? AND kind LIKE 'repo:%' AND (kind LIKE '%:actions' OR kind LIKE '%:actions#2' OR kind LIKE '%:releases' OR kind LIKE '%:releases#2' OR kind LIKE '%:details')",
			)
			.bind(account)
			.all<SnapshotPage>();
		const read = (name: string, suffix: string) => {
			const key = `repo:${name}:${suffix}`;
			const pages = rows.results.filter((r) => r.kind === key || r.kind === `${key}#2`);
			return pages.length ? assemblePages(key, pages) : null;
		};
		const entries: CiEntry[] = [];
		const times: (string | null)[] = [];
		const missing: string[] = [];
		for (const repo of policy.repos) {
			const actions = read(repo.name_with_owner, "actions");
			const releases = read(repo.name_with_owner, "releases");
			const details = read(repo.name_with_owner, "details");
			for (const s of [actions, releases, details])
				times.push(typeof s?.fetched_at === "string" ? s.fetched_at : null);
			if (!actions && !releases) {
				missing.push(repo.name_with_owner);
				continue;
			}
			entries.push({
				repo: repo.name_with_owner,
				fetched_at: String(actions?.fetched_at ?? releases?.fetched_at ?? ""),
				default_branch:
					typeof details?.default_branch === "string" ? details.default_branch : "main",
				runs: (actions?.runs ?? []) as CiEntry["runs"],
				releases: (releases?.releases ?? []) as NonNullable<CiEntry["releases"]>,
				truncated: actions?.truncated === true || releases?.truncated === true,
			});
		}
		const freshness = snapshotFreshness(times);
		return observationEnvelope(
			account,
			resource,
			{
				...ciReport(entries, freshness.latestAt ?? "1970-01-01T00:00:00Z"),
				fetched_at: freshness.latestAt,
				freshness,
				unsaved: missing,
			},
			scope,
		);
	}
	const snapshot = await readSnapshot(db, account, resource);
	if (!snapshot) throw new ApiError(409, "snapshot_missing", "no saved source");
	let data = { ...snapshot };
	if (resource === "repos")
		data = {
			...data,
			repos: policy.repos.map((r) => ({
				...r,
				statistics_enabled: policy.enabled(r.name_with_owner),
				starred: policy.starred(r.name_with_owner),
			})),
		};
	if (scope === "starred" && !resource.startsWith("repo:")) {
		for (const key of ["issues", "pull_requests"])
			if (Array.isArray(data[key]))
				data[key] = data[key].filter((r: Record<string, unknown>) =>
					policy.includes(String(r.name_with_owner)),
				);
		if (data.repository_fetched_at && typeof data.repository_fetched_at === "object")
			data.repository_fetched_at = Object.fromEntries(
				Object.entries(data.repository_fetched_at).filter(([name]) => policy.includes(name)),
			);
	}
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
