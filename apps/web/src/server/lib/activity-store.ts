import { z } from "zod";
import type { ActivityRepo, ActivitySnapshot } from "../../lib/activity-types";
import type { FactoryRepo, FactoryStreamData } from "../../lib/factory-types";
import {
	activityRepo,
	activityTotals,
	completeActivity,
	isActivityRun,
	requireActivityWindow,
	unknownActivity,
} from "./activity";
import type { ActivitySupplement } from "./activity-collect";
import { observationVersion } from "./content-version";
import type { Db } from "./db/d1";
import { fenced, type RunLease } from "./db/factory-runs";
import { ApiError } from "./errors";
import { assemblePages } from "./snapshot-pages";

const MAX_BYTES = 1_500_000;
const MAX_PAGES = 16;
const MAX_INPUT_BYTES = 4_000_000;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export function packActivity(snapshot: ActivitySnapshot) {
	const saved = structuredClone(snapshot);
	saved.membership = snapshot.membership ?? snapshot.repos.map((repo) => repo.repo);
	let page: ActivityRepo[] = [];
	const pages: ActivityRepo[][] = [page];
	let lost = false;
	for (const repo of saved.repos) {
		for (let attempt = 0; bytes([repo]) > MAX_BYTES && attempt < 16; attempt++) {
			repo.ci_runs = repo.ci_runs?.slice(0, Math.floor(repo.ci_runs.length / 2)) ?? null;
			for (const key of ["opened", "merged", "closed"] as const)
				repo.prs[key] =
					repo.prs[key]?.slice(0, Math.floor((repo.prs[key]?.length ?? 0) / 2)) ?? null;
			for (const key of ["opened", "closed"] as const)
				repo.issues[key] =
					repo.issues[key]?.slice(0, Math.floor((repo.issues[key]?.length ?? 0) / 2)) ?? null;
			repo.releases = repo.releases?.slice(0, Math.floor(repo.releases.length / 2)) ?? null;
			repo.commits.items =
				repo.commits.items?.slice(0, Math.floor(repo.commits.items.length / 2)) ?? null;
			repo.commits.default = null;
			repo.commits.other = null;
			repo.deploy.runs =
				repo.deploy.runs?.slice(0, Math.floor(repo.deploy.runs.length / 2)) ?? null;
			repo.snapshot.open_prs = null;
			repo.snapshot.open_issues = null;
			for (const key of Object.keys(repo.coverage))
				repo.coverage[key] = {
					status: "partial",
					truncated: true,
					reason: "Activity page byte capacity reached",
				};
			lost = true;
		}
		if (bytes([repo]) > MAX_BYTES)
			throw new ApiError(
				422,
				"factory_capacity",
				"Activity repository metadata exceeds page capacity",
			);
		if (bytes([...page, repo]) > MAX_BYTES) {
			if (pages.length === MAX_PAGES) {
				lost = true;
				break;
			}
			page = [];
			pages.push(page);
		}
		page.push(repo);
	}
	saved.repos = pages.flat();
	if (lost) {
		saved.truncated = true;
		saved.coverage.repos = {
			status: "partial",
			truncated: true,
			reason: "Activity page capacity reached; retained subset only",
		};
	}
	saved.totals = activityTotals(saved.repos);
	if (saved.repos.length < snapshot.repos.length || saved.repos.length < saved.membership.length)
		for (const key of Object.keys(saved.totals) as (keyof ActivitySnapshot["totals"])[])
			saved.totals[key] = null;
	const header: ActivitySnapshot = { ...saved, repos: [] };
	while (bytes(header) > MAX_BYTES && (header.totals.red_default_branch?.length ?? 0) > 0) {
		header.totals.red_default_branch =
			header.totals.red_default_branch?.slice(
				0,
				Math.floor(header.totals.red_default_branch.length / 2),
			) ?? null;
		header.truncated = true;
		header.coverage.totals = {
			status: "partial",
			truncated: true,
			reason: "Red workflow list exceeds header capacity",
		};
	}
	if (bytes(header) > MAX_BYTES)
		throw new ApiError(422, "factory_capacity", "Activity metadata exceeds page capacity");
	return { header, pages: pages.map((page) => JSON.stringify(page)) };
}
export async function activityPublicationWrites(
	db: Db,
	lease: RunLease,
	now: string,
	repositories: FactoryRepo[],
) {
	const run = lease.run;
	if (
		!isActivityRun(run) ||
		!run.activityWindow ||
		!["running", "completed", "partial"].includes(run.status)
	)
		return [];
	const lengths = await db
		.prepare(
			"SELECT repo,length(CAST(payload AS BLOB)) AS bytes FROM factory_resources WHERE run_id=? AND stream='activity-snapshot' AND repo IN (SELECT value FROM json_each(?)) LIMIT 500",
		)
		.bind(run.id, JSON.stringify(run.repos))
		.all<{ repo: string; bytes: number }>();
	const sizes = new Map(lengths.results.map((row) => [row.repo, row.bytes]));
	let inputBytes = 0;
	const selected: { repo: string; bytes: number }[] = [];
	for (const repo of run.repos) {
		const size = sizes.get(repo);
		if (size === undefined || inputBytes + size > MAX_INPUT_BYTES) continue;
		selected.push({ repo, bytes: size });
		inputBytes += size;
	}
	const resources = await db
		.prepare(
			"SELECT f.repo,f.payload FROM json_each(?) selected JOIN factory_resources f ON f.repo=json_extract(selected.value,'$.repo') AND length(CAST(f.payload AS BLOB))=json_extract(selected.value,'$.bytes') WHERE f.run_id=? AND f.stream='activity-snapshot' ORDER BY CAST(selected.key AS INTEGER)",
		)
		.bind(JSON.stringify(selected), run.id)
		.all<{ repo: string; payload: string }>();
	const frozen = new Map(
		resources.results.map((row) => [row.repo, JSON.parse(row.payload) as ActivityRepo]),
	);
	const mapped = new Map(repositories.map((repo) => [repo.name, repo]));
	const inputOmitted = lengths.results.some((row) => !frozen.has(row.repo));
	const repos = run.repos.flatMap((name) => {
		const repo = mapped.get(name);
		if (!repo)
			throw new ApiError(409, "snapshot_missing", "Frozen activity repository metadata missing");
		if (sizes.has(name) && !frozen.has(name)) return [];
		const activity =
			frozen.get(name) ?? activityRepo(repo, new Map(), requireActivityWindow(run), null, null);
		const incomplete = run.steps.filter(
			(step) => step.repo === name && ["failed", "unavailable", "limited"].includes(step.status),
		);
		if (incomplete.length)
			activity.coverage.run = {
				status: "partial",
				truncated: incomplete.some((step) => step.status === "limited"),
				reason: "One or more repository steps failed, were unavailable or limited",
			};
		return [activity];
	});
	const contributions = run.activityContributions ?? null;
	const snapshot: ActivitySnapshot = {
		membership: run.repos,
		account_id: run.account_id,
		window: run.activityWindow,
		runId: run.id,
		previousRunId: run.previousActivityRunId ?? null,
		fetchedAt: now,
		repos,
		totals: activityTotals(repos),
		contributions,
		coverage: {
			input: inputOmitted
				? {
						status: "partial",
						truncated: true,
						reason:
							"Frozen activity records omitted by the 4 MB publication input budget or changed byte lengths",
					}
				: completeActivity(),
			repos:
				!inputOmitted &&
				repos.every((repo) =>
					Object.values(repo.coverage).every((value) => value.status === "complete"),
				)
					? completeActivity()
					: {
							status: "partial",
							truncated:
								inputOmitted ||
								repos.some((repo) => Object.values(repo.coverage).some((value) => value.truncated)),
							reason: "One or more repository lists have missing or partial evidence",
						},
			contributions: contributions?.days.every((day) => day.coverage.status === "complete")
				? completeActivity()
				: {
						status: contributions ? "partial" : "unavailable",
						truncated: contributions?.days.some((day) => day.coverage.truncated) ?? false,
						reason: contributions
							? "Beijing types are independent of GitHub calendar counts"
							: "Beijing contribution collection unavailable",
					},
		},
		truncated:
			inputOmitted ||
			repos.some((repo) => Object.values(repo.coverage).some((value) => value.truncated)) ||
			(contributions?.days.some((day) => day.coverage.truncated) ?? false),
	};
	const { header, pages } = packActivity(snapshot);
	const content = await observationVersion({
		...header,
		repos: pages.map((page) => JSON.parse(page)),
	});
	return [
		fenced(
			db,
			lease,
			now,
			"INSERT INTO activity_publications(account_id,run_id,previous_run_id,until_at,fetched_at,payload,content_version) SELECT ?,?,?,?,?,?,? WHERE $guard ON CONFLICT(account_id,run_id) DO NOTHING",
			[
				run.account_id,
				run.id,
				header.previousRunId,
				header.window.until,
				now,
				JSON.stringify(header),
				content,
			],
		),
		...pages.map((payload, page) =>
			fenced(
				db,
				lease,
				now,
				"INSERT INTO activity_pages(account_id,run_id,page,payload) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM activity_publications WHERE account_id=? AND run_id=? AND content_version=?) AND $guard ON CONFLICT(account_id,run_id,page) DO NOTHING",
				[run.account_id, run.id, page, payload, run.account_id, run.id, content],
			),
		),
	];
}
export async function freezeActivityRepo(
	db: Db,
	lease: RunLease,
	now: string,
	repo: FactoryRepo,
	supplement: ActivitySupplement,
) {
	const run = lease.run;
	const [resources, snapshots] = await db.batch<{ stream: string; payload: string; kind: string }>([
		db
			.prepare(
				"SELECT stream,payload FROM factory_resources WHERE run_id=? AND repo=? AND stream IN ('commits','actions','prs','issues','releases')",
			)
			.bind(run.id, repo.name),
		db
			.prepare(
				"SELECT substr(stream,6) AS kind,payload FROM factory_resources WHERE run_id=? AND repo='' AND stream IN (?,?)",
			)
			.bind(run.id, `site:repo:${repo.name}:security`, `site:repo:${repo.name}:security#2`),
	]);
	if (!resources || !snapshots)
		throw new ApiError(500, "db_error", "Incomplete activity source batch");
	const expectedRepoId = run.repoIds[repo.name];
	const currentRepo =
		(expectedRepoId === undefined || expectedRepoId === repo.id) &&
		(repo.observation?.version === run.id ||
			run.steps.some(
				(step) => step.repo === repo.name && step.kind === "commit" && step.status === "success",
			));
	const streams = new Map(
		resources.results.flatMap((row) => {
			const data = JSON.parse(row.payload) as FactoryStreamData;
			return data.runId === run.id && currentRepo ? [[row.stream, data] as const] : [];
		}),
	);
	const kind = `repo:${repo.name}:security`;
	const step = run.steps.find((step) => step.kind === "snapshot" && step.resource === kind);
	const candidate = assemblePages(kind, snapshots.results);
	const observedAt =
		typeof candidate.fetched_at === "string" ? Date.parse(candidate.fetched_at) : NaN;
	const verified =
		step &&
		["success", "unavailable"].includes(step.status) &&
		observedAt >= Date.parse(step.startedAt ?? "") &&
		observedAt <= Date.parse(step.finishedAt ?? "") &&
		observedAt >= Date.parse(run.startedAt);
	const security = verified ? candidate : null;
	const activity = activityRepo(repo, streams, requireActivityWindow(run), supplement, security);
	if (Date.parse(requireActivityWindow(run).since) < Date.parse(run.window.since))
		for (const key of ["commits", "actions"])
			activity.coverage[key] = {
				status: "partial",
				truncated: true,
				reason: "Activity window begins before the collected 90-day stream",
			};
	if (activity.coverage.commits?.status !== "complete") {
		activity.commits.default = null;
		activity.commits.other = null;
	}
	const snapshot: ActivitySnapshot = {
		account_id: run.account_id,
		window: requireActivityWindow(run),
		runId: run.id,
		previousRunId: run.previousActivityRunId ?? null,
		fetchedAt: now,
		repos: [activity],
		totals: activityTotals([activity]),
		contributions: null,
		coverage: {},
		truncated: false,
	};
	const packed = packActivity(snapshot);
	return fenced(
		db,
		lease,
		now,
		"INSERT INTO factory_resources(run_id,repo,stream,payload) SELECT ?,?,'activity-snapshot',? WHERE $guard ON CONFLICT(run_id,repo,stream) DO NOTHING",
		[run.id, repo.name, JSON.stringify(JSON.parse(packed.pages[0] ?? "[]")[0])],
	);
}
const querySchema = z
	.object({
		run: z
			.string()
			.regex(/^[A-Za-z0-9_-]{1,80}$/)
			.optional(),
		repository: z
			.string()
			.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
			.max(200)
			.optional(),
	})
	.strict();
export async function readActivity(
	db: Db,
	account: string,
	query: Record<string, string[]>,
): Promise<ActivitySnapshot> {
	if (Object.values(query).some((values) => values.length !== 1))
		throw new ApiError(400, "validation_failed", "Duplicate activity filter");
	const parsed = querySchema.safeParse(
		Object.fromEntries(Object.entries(query).map(([key, values]) => [key, values[0]])),
	);
	if (!parsed.success) throw new ApiError(400, "validation_failed", "Invalid activity filters");
	const id = parsed.data.run ?? "latest";
	const target =
		"SELECT a.run_id,a.payload FROM activity_publications a JOIN factory_runs r ON r.id=a.run_id AND r.account_id=a.account_id WHERE a.account_id=? AND (?='latest' OR a.run_id=?) AND r.status IN ('completed','partial') ORDER BY a.until_at DESC,a.run_id LIMIT 1";
	const [headers, pages, runs] = await db.batch<{ payload: string; status: string }>([
		db.prepare(target).bind(account, id, id),
		db
			.prepare(
				`WITH target AS (${target}) SELECT p.payload FROM activity_pages p JOIN target t ON t.run_id=p.run_id WHERE p.account_id=? ORDER BY p.page`,
			)
			.bind(account, id, id, account),
		db.prepare("SELECT status FROM factory_runs WHERE account_id=? AND id=?").bind(account, id),
	]);
	const header = headers?.results[0];
	if (!header) {
		if (id !== "latest" && !runs?.results.length)
			throw new ApiError(404, "not_found", "Unknown activity run");
		throw new ApiError(
			409,
			"activity_unpublished",
			"No successful published account activity for this run",
		);
	}
	const snapshot = JSON.parse(header.payload) as ActivitySnapshot;
	snapshot.repos =
		pages?.results.flatMap((page) => JSON.parse(page.payload) as ActivityRepo[]) ?? [];
	const repository = parsed.data.repository;
	if (repository) {
		const frozenMember =
			snapshot.membership?.some((name) => name.toLowerCase() === repository.toLowerCase()) ?? false;
		const matching = snapshot.repos.filter(
			(repo) => repo.repo.toLowerCase() === repository.toLowerCase(),
		);
		if (!matching.length && !frozenMember) {
			const rows = await db
				.prepare(
					"SELECT kind,payload FROM snapshots WHERE account_id=? AND kind IN ('repos','repos#2')",
				)
				.bind(account)
				.all<{ kind: string; payload: string }>();
			const catalog = assemblePages("repos", rows.results);
			if (
				!Array.isArray(catalog.repos) ||
				!catalog.repos.some(
					(repo: { name_with_owner?: string }) =>
						repo.name_with_owner?.toLowerCase() === repository.toLowerCase(),
				)
			)
				throw new ApiError(
					404,
					"not_found",
					"Repository outside frozen activity and current catalog",
				);
		}
		snapshot.repos = matching;
		snapshot.totals = activityTotals(matching);
		const omitted =
			!matching.length && (frozenMember || (!snapshot.membership && snapshot.truncated));
		if (omitted)
			for (const key of Object.keys(snapshot.totals) as (keyof ActivitySnapshot["totals"])[])
				snapshot.totals[key] = null;
		snapshot.contributions = null;
		snapshot.coverage = {
			repos: omitted
				? {
						status: "partial",
						truncated: true,
						reason: "Frozen repository activity was omitted by storage capacity",
					}
				: matching.length
					? (snapshot.coverage.repos ?? unknownActivity("Repository coverage unavailable"))
					: {
							status: "complete",
							truncated: false,
							reason: "Repository not included in this frozen run",
						},
			contributions: unknownActivity("Account contributions cannot be projected to a repository"),
		};
		snapshot.truncated =
			omitted ||
			matching.some((repo) => Object.values(repo.coverage).some((value) => value.truncated));
	}
	return snapshot;
}
