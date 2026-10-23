import { factoryWindow } from "../../../lib/factory";
import { normalizeRepoDependencies } from "../../../lib/factory-dependencies";
import {
	type FactoryRun,
	REPO_COOLDOWN_MS,
	type RepoRefreshState,
	RUN_COOLDOWN_MS,
	RUN_LEASE_MS,
} from "../../../lib/factory-run";
import type { FactorySnapshot } from "../../../lib/factory-types";
import { activityWindow, isActivityRun } from "../activity";
import { storedContent, withContent } from "../content-version";
import { ApiError } from "../errors";
import { decodeRun, encodeRun } from "../factory-run-codec";
import { RUN_DEADLINE_SQL, runDeadlineAt, timedOutRun } from "../factory-timeout";
import { beijingDayStart, SCHEDULE_ADMISSION } from "../schedule-admission";
import type { Db } from "./d1";
import { applyRunJournal, runAudits, saveRunAudits } from "./factory-run-journal";
import { readSnapshot } from "./snapshots";

type RunRow = {
	payload: string;
	lease_token: string | null;
	lease_until: string | null;
	version: number;
	journal?: string;
	invocations?: number;
};
export type RunLease = {
	run: FactoryRun;
	token: string;
	version: number;
	leaseUntil: string;
	fenceAt?: string;
	attemptedSteps?: Map<number, number>;
};
export type FactoryHead = {
	published_id: string | null;
	catalog_id: string | null;
	next_at: string;
};
const parse = (row: RunRow) => {
	const run = {
		publishedAt: null,
		...decodeRun(row.payload),
		...(row.version === undefined ? {} : { version: row.version }),
		...(row.invocations ? { invocations: row.invocations } : {}),
	} as FactoryRun;
	if (row.journal && ["running", "paused"].includes(run.status)) applyRunJournal(run, row.journal);
	return { run, leaseUntil: row.lease_until };
};
export async function getRun(db: Db, account: string, id: string) {
	const row = await db
		.prepare(
			"SELECT payload,lease_until,version,(SELECT journal FROM factory_run_journal WHERE run_id=id) AS journal,(SELECT invocations FROM factory_run_journal WHERE run_id=id) AS invocations FROM factory_runs WHERE account_id=? AND id=?",
		)
		.bind(account, id)
		.first<RunRow>();
	return row ? { ...parse(row), journal: row.journal ?? "{}" } : null;
}
export function dispatchRunState(db: Db, id: string) {
	return db
		.prepare("SELECT account_id,status FROM factory_runs WHERE id=?")
		.bind(id)
		.first<{ account_id: string; status: string }>();
}
export type RunListRow = RunRow & {
	total: number;
	success: number;
	failed: number;
	skipped: number;
	unavailable: number;
	limited: number;
};
export function listRunsStatement(db: Db, account: string, detail = ""): D1PreparedStatement {
	return db
		.prepare(`SELECT
 CASE WHEN status IN ('running','paused') OR id=COALESCE(NULLIF(?,''),(SELECT id FROM factory_runs WHERE account_id=? ORDER BY created_at DESC LIMIT 1)) THEN json_remove(payload,'$.checkpoint') ELSE json_remove(payload,'$.checkpoint','$.steps') END AS payload,
 lease_until,version,(SELECT journal FROM factory_run_journal WHERE run_id=id) AS journal,(SELECT invocations FROM factory_run_journal WHERE run_id=id) AS invocations,json_array_length(payload,'$.steps') AS total,
 (SELECT COUNT(*) FROM json_each(payload,'$.steps') WHERE json_extract(value,'$.status')='success') AS success,
 (SELECT COUNT(*) FROM json_each(payload,'$.steps') WHERE json_extract(value,'$.status')='failed') AS failed,
 (SELECT COUNT(*) FROM json_each(payload,'$.steps') WHERE json_extract(value,'$.status')='unavailable') AS unavailable,
 (SELECT COUNT(*) FROM json_each(payload,'$.steps') WHERE json_extract(value,'$.status')='limited') AS limited,
 (SELECT COUNT(*) FROM json_each(payload,'$.steps') WHERE json_extract(value,'$.status')='skipped') AS skipped
 FROM factory_runs WHERE account_id=? ORDER BY CASE WHEN status IN ('running','paused') THEN 0 ELSE 1 END,created_at DESC LIMIT 21`)
		.bind(detail, account, account);
}
export async function listRuns(db: Db, account: string, detail = "") {
	return decodeRuns((await listRunsStatement(db, account, detail).all<RunListRow>()).results);
}
export function decodeRuns(rows: RunListRow[]) {
	return rows.map((row) => {
		const entry = parse(row);
		entry.run.steps ??= [];
		return {
			...entry,
			counts: {
				total: row.total,
				success: row.success,
				failed: row.failed,
				skipped: row.skipped,
				unavailable: row.unavailable,
				limited: row.limited,
			},
		};
	});
}
export const factoryHead = (db: Db, account: string) =>
	db
		.prepare("SELECT published_id,catalog_id,next_at FROM factory_state WHERE account_id=?")
		.bind(account)
		.first<FactoryHead>();
export function normalizePublication(snapshot: FactorySnapshot): FactorySnapshot {
	return withContent(
		{ ...snapshot, repos: snapshot.repos.map(normalizeRepoDependencies) },
		storedContent(snapshot),
	) as FactorySnapshot;
}
export async function publishedFactory(db: Db, account: string): Promise<FactorySnapshot | null> {
	const head = await factoryHead(db, account);
	const snapshot = (await readSnapshot(
		db,
		account,
		head?.published_id ? `factory:v:${head.published_id}` : "factory",
	)) as FactorySnapshot | null;
	return snapshot ? normalizePublication(snapshot) : null;
}
export async function catalogFactory(db: Db, account: string): Promise<FactorySnapshot | null> {
	const head = await factoryHead(db, account);
	return head?.catalog_id
		? ((await readSnapshot(
				db,
				account,
				`factory:catalog:${head.catalog_id}`,
			)) as FactorySnapshot | null)
		: publishedFactory(db, account);
}
export async function repoStates(db: Db, account: string): Promise<RepoRefreshState[]> {
	const rows = await db
		.prepare("SELECT payload FROM factory_repo_state WHERE account_id=? ORDER BY repo")
		.bind(account)
		.all<{ payload: string }>();
	return rows.results.map((r) => JSON.parse(r.payload) as RepoRefreshState);
}
const ACTIVITY_ELIGIBLE_SQL =
	"json_extract(payload,'$.mode')='refresh' AND json_extract(payload,'$.depth')='quick' AND coalesce(json_extract(payload,'$.trigger'),'manual')!='weekly' AND (json_extract(payload,'$.trigger')='daily' OR json_extract(payload,'$.selection.scope')='all') AND coalesce(json_extract(payload,'$.selection.repo'),'')=''";
const ACTIVITY_PUBLISHED_SQL =
	"EXISTS(SELECT 1 FROM activity_publications a WHERE a.account_id=factory_runs.account_id AND a.run_id=factory_runs.id)";
const ACTIVITY_PREVIOUS_SQL = `FROM factory_runs WHERE account_id=? AND status IN ('completed','partial') AND ${ACTIVITY_PUBLISHED_SQL} AND ${ACTIVITY_ELIGIBLE_SQL} AND julianday(json_extract(payload,'$.window.until')) IS NOT NULL AND json_extract(payload,'$.window.until')<? ORDER BY json_extract(payload,'$.window.until') DESC,id LIMIT 1`;
const ACTIVITY_INTERRUPTED_SQL = `FROM factory_runs WHERE account_id=? AND (status IN ('failed','cancelled') OR (status IN ('completed','partial') AND NOT ${ACTIVITY_PUBLISHED_SQL})) AND created_at>? AND ${ACTIVITY_ELIGIBLE_SQL} LIMIT 1`;
export async function startRun(
	db: Db,
	run: FactoryRun,
	clock = () => run.startedAt,
	admissionAttempt = 0,
): Promise<FactoryRun> {
	await expireRuns(db, clock(), run.account_id);
	const old = await db
		.prepare("SELECT payload FROM factory_runs WHERE account_id=? AND request_key=?")
		.bind(run.account_id, run.requestKey)
		.first<{ payload: string }>();
	if (old) return decodeRun(old.payload);
	const acceptedAt = clock();
	if (acceptedAt !== run.startedAt) {
		run.startedAt = acceptedAt;
		run.updatedAt = acceptedAt;
		run.nextAttemptAt = acceptedAt;
		run.window = factoryWindow(acceptedAt, run.depth === "quick" ? 30 : 90);
	}
	let previousActivityStart = "";
	let activityInterrupted = false;
	if (isActivityRun(run)) {
		const history = await db
			.prepare(`SELECT payload ${ACTIVITY_PREVIOUS_SQL}`)
			.bind(run.account_id, run.window.until)
			.first<{ payload: string }>();
		const previous = history ? decodeRun(history.payload) : null;
		const interrupted = await db
			.prepare(`SELECT 1 AS n ${ACTIVITY_INTERRUPTED_SQL}`)
			.bind(run.account_id, previous?.startedAt ?? "")
			.first();
		previousActivityStart = previous?.startedAt ?? "";
		activityInterrupted = Boolean(interrupted);
		run.activityWindow = activityWindow(run, previous, Boolean(interrupted));
		run.previousActivityRunId = previous?.id ?? null;
	}
	if (!isActivityRun(run))
		run.steps = run.steps.filter(
			(step) => !["activity", "activity-contributions"].includes(step.kind),
		);
	run.deadlineAt = runDeadlineAt(run);
	const insert = db
		.prepare(`INSERT OR IGNORE INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at)
 SELECT ?,?,?,'running',?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM factory_runs WHERE account_id=? AND status IN ('running','paused'))
	 AND (? OR NOT EXISTS(SELECT 1 FROM factory_runs WHERE account_id=? AND created_at>? AND json_array_length(payload,'$.steps')>0))
	 AND (? OR NOT EXISTS(SELECT 1 FROM factory_state WHERE account_id=? AND next_at>?))
 AND NOT EXISTS(SELECT 1 FROM snapshots WHERE account_id=? AND kind='factory:lock' AND fetched_at>?)
 AND (?=0 OR (coalesce((SELECT id ${ACTIVITY_PREVIOUS_SQL}),'')=? AND EXISTS(SELECT 1 ${ACTIVITY_INTERRUPTED_SQL})=?))
	 AND (? IS NULL OR ${SCHEDULE_ADMISSION})`)
		.bind(
			run.id,
			run.account_id,
			run.requestKey,
			encodeRun(run),
			run.startedAt,
			run.startedAt,
			run.startedAt,
			run.account_id,
			Number(Boolean(run.schedule)),
			run.account_id,
			new Date(Date.parse(run.startedAt) - RUN_COOLDOWN_MS).toISOString(),
			Number(Boolean(run.schedule)),
			run.account_id,
			run.startedAt,
			run.account_id,
			run.startedAt,
			Number(isActivityRun(run)),
			run.account_id,
			run.window.until,
			run.previousActivityRunId ?? "",
			run.account_id,
			previousActivityStart,
			Number(activityInterrupted),
			run.schedule?.kind ?? null,
			run.account_id,
			run.startedAt,
			beijingDayStart(run.startedAt),
			run.schedule?.kind ?? null,
			run.schedule?.dueAt ?? null,
		);
	const results = await db.batch([
		insert,
		db
			.prepare(
				"INSERT INTO factory_state(account_id,next_at) SELECT ?,? WHERE EXISTS(SELECT 1 FROM factory_runs WHERE id=? AND account_id=? AND request_key=?) ON CONFLICT(account_id) DO UPDATE SET next_at=MAX(next_at,excluded.next_at)",
			)
			.bind(
				run.account_id,
				new Date(Date.parse(run.startedAt) + RUN_COOLDOWN_MS).toISOString(),
				run.id,
				run.account_id,
				run.requestKey,
			),
	]);
	const inserted = results[0];

	if (!inserted?.meta.changes) {
		const duplicate = await db
			.prepare("SELECT payload FROM factory_runs WHERE account_id=? AND request_key=?")
			.bind(run.account_id, run.requestKey)
			.first<{ payload: string }>();
		if (duplicate) return decodeRun(duplicate.payload);
		const active = await db
			.prepare("SELECT id FROM factory_runs WHERE account_id=? AND status IN ('running','paused')")
			.bind(run.account_id)
			.first();
		if (!active && isActivityRun(run)) {
			const changed = await db
				.prepare(
					`SELECT (coalesce((SELECT id ${ACTIVITY_PREVIOUS_SQL}),'')!=? OR EXISTS(SELECT 1 ${ACTIVITY_INTERRUPTED_SQL})!=?) AS changed`,
				)
				.bind(
					run.account_id,
					run.window.until,
					run.previousActivityRunId ?? "",
					run.account_id,
					previousActivityStart,
					Number(activityInterrupted),
				)
				.first<{ changed: number }>();
			if (changed?.changed) {
				if (admissionAttempt >= 2)
					throw new ApiError(
						409,
						"account_conflict",
						"Activity predecessor changed during admission; retry",
					);
				return startRun(db, run, clock, admissionAttempt + 1);
			}
		}

		if (!active && run.schedule)
			throw new ApiError(
				409,
				"schedule_deferred",
				"schedule changed or another occurrence has priority",
			);
		throw new ApiError(
			409,
			active ? "account_conflict" : "refresh_cooldown",
			active ? "a run already exists" : "refresh cooldown; read nextAllowedAt",
		);
	}
	return run;
}
export async function claimRun(
	db: Db,
	id: string,
	now: string,
	expire = true,
): Promise<RunLease | null> {
	if (expire) await expireRuns(db, now, "", id);
	const token = crypto.randomUUID();
	const until = new Date(Date.parse(now) + RUN_LEASE_MS).toISOString();
	const row = await db
		.prepare(
			`SELECT payload,version,lease_until,(SELECT journal FROM factory_run_journal WHERE run_id=id) AS journal,(SELECT invocations FROM factory_run_journal WHERE run_id=id) AS invocations FROM factory_runs WHERE id=? AND status='running' AND next_at<=? AND (lease_until IS NULL OR lease_until<=?) AND ${RUN_DEADLINE_SQL}>?`,
		)
		.bind(id, now, now, now)
		.first<RunRow>();
	if (!row) return null;
	const run = decodeRun(row.payload);
	run.deadlineAt = runDeadlineAt(run);
	run.version = row.version + 1;
	run.updatedAt = now;
	run.invocations = (row.invocations ?? 0) + 1;
	const leaseUntil = until < run.deadlineAt ? until : run.deadlineAt;
	const result = await db.batch([
		db
			.prepare(
				`UPDATE factory_runs SET lease_token=?,lease_until=?,updated_at=?,version=version+1 WHERE id=? AND version=? AND status='running' AND next_at<=? AND (lease_until IS NULL OR lease_until<=?) AND ${RUN_DEADLINE_SQL}>?`,
			)
			.bind(token, leaseUntil, now, id, row.version, now, now, now),
		db
			.prepare(
				"INSERT INTO factory_run_journal(run_id,invocations) SELECT ?,1 WHERE EXISTS(SELECT 1 FROM factory_runs WHERE id=? AND lease_token=?) ON CONFLICT(run_id) DO UPDATE SET invocations=invocations+1",
			)
			.bind(id, id, token),
	]);
	if (!result[0]?.meta.changes) return null;
	if (row.journal) applyRunJournal(run, row.journal, true);
	return { run, token, version: run.version, leaseUntil };
}
const fencedWrites = new WeakMap<
	D1PreparedStatement,
	{ lease: RunLease; now: string; sql: string; values: unknown[] }
>();

export function rebindRunWrites(db: Db, lease: RunLease, writes: D1PreparedStatement[]) {
	return writes.map((statement) => {
		const saved = fencedWrites.get(statement);
		if (!saved) return statement;
		if (saved.lease.token !== lease.token || saved.lease.run.id !== lease.run.id)
			throw new ApiError(409, "factory_lease_lost", "factory write ownership changed");
		return fenced(db, lease, saved.now, saved.sql, saved.values);
	});
}

export function fenced(
	db: Db,
	lease: RunLease,
	now: string,
	sql: string,
	values: unknown[] = [],
): D1PreparedStatement {
	lease.fenceAt = lease.fenceAt && lease.fenceAt > now ? lease.fenceAt : now;
	const guard = `EXISTS(SELECT 1 FROM factory_runs WHERE id=? AND lease_token=? AND version=? AND lease_until>? AND ${RUN_DEADLINE_SQL}>? AND status='running')`;
	const statement = db
		.prepare(sql.replace("$guard", guard))
		.bind(...values, lease.run.id, lease.token, lease.version, now, now);
	fencedWrites.set(statement, { lease, now, sql, values });
	return statement;
}
export async function saveRun(
	db: Db,
	lease: RunLease,
	writes: D1PreparedStatement[],
	now: string,
	keepLease = false,
	acceptedStep?: number,
): Promise<boolean> {
	const run = lease.run;
	await expireRuns(db, now, run.account_id, run.id);
	if (lease.attemptedSteps && !(await saveRunAudits(db, lease, now))) return false;
	run.deadlineAt = runDeadlineAt(run);
	run.updatedAt = now;
	run.version = lease.version + 1;
	const expiresAfter = lease.fenceAt && lease.fenceAt > now ? lease.fenceAt : now;
	const validSql = `SELECT 1 FROM factory_runs WHERE id=? AND lease_token=? AND version=? AND lease_until>? AND ${RUN_DEADLINE_SQL}>? AND status='running'`;
	const args = [run.id, lease.token, lease.version, expiresAfter, expiresAfter];
	try {
		const result = await db.batch([
			// A failed final CAS must not leave earlier writes committed. Abort the transaction first.
			db.prepare(`SELECT CASE WHEN EXISTS(${validSql}) THEN 1 ELSE json('{') END`).bind(...args),
			...writes,
			fenced(db, lease, now, "UPDATE factory_run_journal SET journal=? WHERE run_id=? AND $guard", [
				acceptedStep === undefined ? "{}" : JSON.stringify(runAudits(lease, acceptedStep)),
				run.id,
			]),
			fenced(
				db,
				lease,
				now,
				"UPDATE factory_runs SET payload=?,status=?,version=version+1,updated_at=?,next_at=?,lease_token=?,lease_until=? WHERE id=? AND $guard",
				[
					encodeRun(run),
					run.status,
					now,
					run.nextAttemptAt,
					keepLease ? lease.token : null,
					keepLease ? lease.leaseUntil : null,
					run.id,
				],
			),
		]);
		const saved = Boolean(result.at(-1)?.meta.changes);
		if (saved) {
			lease.version = run.version;
			if (acceptedStep === undefined) lease.attemptedSteps?.clear();
			else lease.attemptedSteps?.delete(acceptedStep);
		}
		return saved;
	} catch (error) {
		if (
			!(await db
				.prepare(validSql)
				.bind(...args)
				.first())
		)
			return false;
		throw error;
	}
}
export async function releaseRunLease(db: Db, lease: RunLease, now: string): Promise<void> {
	await fenced(
		db,
		lease,
		now,
		"UPDATE factory_runs SET lease_token=NULL,lease_until=NULL WHERE id=? AND $guard",
		[lease.run.id],
	).run();
}

export async function nextRunAttempt(db: Db, id: string): Promise<string | null> {
	const row = await db
		.prepare(
			"SELECT MAX(next_at,coalesce(lease_until,next_at)) AS next_at FROM factory_runs WHERE id=? AND status='running'",
		)
		.bind(id)
		.first<{ next_at: string }>();
	return row?.next_at ?? null;
}
export async function controlRun(
	db: Db,
	account: string,
	id: string,
	action: "pause" | "resume" | "cancel",
	now: string,
): Promise<FactoryRun> {
	await expireRuns(db, now, account, id);
	const found = await getRun(db, account, id);
	if (!found) throw new ApiError(404, "not_found", "run not found");
	const run = found.run;
	if (!["running", "paused"].includes(run.status)) return run;
	const attemptedRepos = new Set<string>();
	for (const [index, step] of run.steps.entries()) {
		if (
			action !== "resume" &&
			step.repo &&
			!["snapshot", "assessment"].includes(step.kind) &&
			(step.status === "running" || index === run.cursor) &&
			run.steps.some((attempted) => attempted.repo === step.repo && attempted.startedAt)
		)
			attemptedRepos.add(step.repo);
	}
	run.status = action === "pause" ? "paused" : action === "resume" ? "running" : "cancelled";
	run.updatedAt = now;
	if (action === "pause")
		for (const step of run.steps) if (step.status === "running") step.status = "pending";
	if (action === "cancel") {
		run.finishedAt = now;
		for (const step of run.steps)
			if (step.status === "pending" || step.status === "running") {
				step.status = "skipped";
				step.finishedAt = now;
				step.error = "cancelled";
			}
	}
	const writes: D1PreparedStatement[] = [];
	for (const repo of attemptedRepos) {
		const prior = await db
			.prepare("SELECT version,payload FROM factory_repo_state WHERE account_id=? AND repo=?")
			.bind(account, repo)
			.first<{ version: string | null; payload: string }>();
		const state: RepoRefreshState = prior
			? (JSON.parse(prior.payload) as RepoRefreshState)
			: { repo, status: "partial", refreshedAt: null, nextAllowedAt: now };
		state.nextAllowedAt =
			[state.nextAllowedAt, new Date(Date.parse(now) + REPO_COOLDOWN_MS).toISOString()]
				.sort()
				.at(-1) ?? now;
		state.attemptRunId = id;
		state.attemptStatus = action;
		state.attemptedAt = now;
		writes.push(
			db
				.prepare(
					"INSERT INTO factory_repo_state(account_id,repo,version,payload) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM factory_runs WHERE account_id=? AND id=? AND version=? AND status IN ('running','paused')) ON CONFLICT(account_id,repo) DO UPDATE SET payload=excluded.payload",
				)
				.bind(
					account,
					repo,
					prior?.version ?? null,
					JSON.stringify(state),
					account,
					id,
					run.version,
				),
		);
	}
	// Resume must preserve rate-limit/backoff deadlines.
	const update = db
		.prepare(
			"UPDATE factory_runs SET status=?,payload=?,version=version+1,lease_token=NULL,lease_until=NULL,updated_at=? WHERE account_id=? AND id=? AND version=? AND status IN ('running','paused')",
		)
		.bind(
			run.status,
			encodeRun({ ...run, version: run.version + 1 }),
			now,
			account,
			id,
			run.version,
		);
	const validSql =
		"SELECT 1 FROM factory_runs WHERE account_id=? AND id=? AND version=? AND status IN ('running','paused') AND coalesce((SELECT journal FROM factory_run_journal WHERE run_id=factory_runs.id),'{}')=?";
	const args = [account, id, run.version, found.journal];
	try {
		await db.batch([
			db.prepare(`SELECT CASE WHEN EXISTS(${validSql}) THEN 1 ELSE json('{') END`).bind(...args),
			...writes,
			db
				.prepare(
					"UPDATE factory_run_journal SET journal='{}' WHERE run_id=? AND EXISTS(SELECT 1 FROM factory_runs WHERE id=? AND version=?)",
				)
				.bind(id, id, run.version),
			update,
		]);
	} catch (error) {
		if (
			!(await db
				.prepare(validSql)
				.bind(...args)
				.first())
		)
			throw new ApiError(409, "account_conflict", "run changed; reload");
		throw error;
	}
	return { ...run, version: run.version + 1 };
}
export async function dueRuns(db: Db, now: string, account = "") {
	await expireRuns(db, now, account);
	const result = await db
		.prepare(
			"SELECT id FROM factory_runs WHERE status='running' AND next_at<=? AND (lease_until IS NULL OR lease_until<=?) AND (?='' OR account_id=?) ORDER BY next_at LIMIT 5",
		)
		.bind(now, now, account, account)
		.all<{ id: string }>();
	return result.results.map((r) => r.id);
}

export async function expireRuns(db: Db, now: string, account = "", id = ""): Promise<void> {
	const rows = await db
		.prepare(
			`SELECT payload,version,(SELECT journal FROM factory_run_journal WHERE run_id=id) AS journal,(SELECT invocations FROM factory_run_journal WHERE run_id=id) AS invocations FROM factory_runs WHERE status IN ('running','paused') AND ${RUN_DEADLINE_SQL}<=? AND (?='' OR account_id=?) AND (?='' OR id=?) ORDER BY updated_at LIMIT 10`,
		)
		.bind(now, account, account, id, id)
		.all<RunRow>();
	for (const row of rows.results) {
		const run = timedOutRun(parse(row).run, now);
		if (!run) continue;
		run.version = row.version + 1;
		const writes: D1PreparedStatement[] = [];
		if (run.schedule)
			writes.push(
				db
					.prepare(
						`UPDATE ${run.schedule.kind === "catalog" ? "catalog_refresh_schedules" : "refresh_schedules"} SET last_error='run_timed_out' WHERE account_id=? AND kind=? AND (last_run_id=? OR next_at=?) AND EXISTS(SELECT 1 FROM factory_runs WHERE id=? AND version=? AND status IN ('running','paused') AND ${RUN_DEADLINE_SQL}<=?)`,
					)
					.bind(
						run.account_id,
						run.schedule.kind,
						run.id,
						run.schedule.dueAt,
						run.id,
						row.version,
						now,
					),
			);
		writes.push(
			db
				.prepare(
					`UPDATE factory_runs SET payload=?,status='failed',version=version+1,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND version=? AND status IN ('running','paused') AND ${RUN_DEADLINE_SQL}<=?`,
				)
				.bind(encodeRun(run), now, run.id, row.version, now),
		);
		await db.batch(writes);
	}
}
