import { type FactoryRun, makeRun } from "../../lib/factory-run";
import {
	defaultSchedule,
	type RefreshSchedule,
	type ScheduleConfig,
	type ScheduleKind,
} from "../../lib/refresh-schedule";
import { getAccount } from "./db/accounts";
import { createDb, type Db } from "./db/d1";
import { catalogFactory, expireRuns } from "./db/factory-runs";
import { ApiError } from "./errors";
import { startRefresh } from "./factory-start";
import { normalizeScheduleConfig } from "./refresh-schedule-input";
import { beijingDayStart, SCHEDULE_PRIORITY } from "./schedule-admission";
import { repoPolicy } from "./snapshot-projection";

export function nextScheduleAt(
	kind: ScheduleKind,
	time: string | string[],
	weekday: number,
	now: string,
): string {
	if (Array.isArray(time))
		return time.map((slot) => nextScheduleAt(kind, slot, weekday, now)).sort()[0] as string;
	const local = new Date(Date.parse(now) + 8 * 3600000);
	const [hour, minute] = time.split(":").map(Number);
	local.setUTCHours(hour ?? 0, minute ?? 0, 0, 0);
	if (kind === "weekly")
		local.setUTCDate(local.getUTCDate() + ((weekday - local.getUTCDay() + 7) % 7));
	if (local.getTime() - 8 * 3600000 <= Date.parse(now))
		local.setUTCDate(local.getUTCDate() + (kind === "weekly" ? 7 : 1));
	return new Date(local.getTime() - 8 * 3600000).toISOString();
}
export type ScheduleRow = {
	kind: ScheduleKind;
	enabled: number;
	time: string;
	times: string;
	weekday: number;
	scope: "all" | "starred";
	next_at: string;
	last_run_id: string | null;
	last_error: string | null;
};
type DueSchedule = ScheduleRow & { account_id: string };
const scheduleTable = (kind: ScheduleKind) =>
	kind === "catalog" ? "catalog_refresh_schedules" : "refresh_schedules";
const scheduleRows =
	"SELECT s.*,t.times FROM (SELECT * FROM refresh_schedules UNION ALL SELECT * FROM catalog_refresh_schedules) s JOIN refresh_schedule_times t USING(account_id,kind)";

function skippedRun(row: DueSchedule, owner: string, now: string, error: string): FactoryRun {
	const run = makeRun(
		crypto.randomUUID(),
		row.account_id,
		owner,
		`${row.kind}:${row.next_at}`,
		row.kind === "catalog" ? "catalog" : "refresh",
		[],
		now,
	);
	return {
		...run,
		depth: row.kind === "weekly" ? "deep" : "quick",
		trigger: row.kind === "weekly" ? "weekly" : "daily",
		schedule: { kind: row.kind, dueAt: row.next_at },
		steps: [],
		status: "failed",
		error,
		finishedAt: now,
		...(error === "scheduled_slot_missed"
			? { missedSlots: { firstDueAt: row.next_at, lastDueAt: row.next_at, count: 1 } }
			: {}),
	};
}

function advanceSchedule(db: Db, row: DueSchedule, run: Pick<FactoryRun, "id" | "error">) {
	return db
		.prepare(
			`UPDATE ${scheduleTable(row.kind)} SET next_at=?,last_run_id=?,last_error=CASE WHEN last_error IN ('run_timed_out','scheduled_slots_missed','scheduled_slot_missed') THEN last_error WHEN ? IS NOT NULL THEN ? WHEN last_error='catalog_preparation_failed' THEN last_error ELSE NULL END WHERE account_id=? AND kind=? AND enabled=1 AND next_at=? AND EXISTS(SELECT 1 FROM factory_runs WHERE id=? AND account_id=? AND request_key=?)`,
		)
		.bind(
			nextScheduleAt(row.kind, JSON.parse(row.times), row.weekday, row.next_at),
			run.id,
			run.error ?? null,
			run.error ?? null,
			row.account_id,
			row.kind,
			row.next_at,
			run.id,
			row.account_id,
			`${row.kind}:${row.next_at}`,
		);
}

async function recordFailure(
	raw: D1Database,
	row: DueSchedule,
	owner: string,
	now: string,
	error: string,
) {
	const db = createDb(raw);
	const run = skippedRun(row, owner, now, error);
	const result = await db.batch([
		db
			.prepare(
				`INSERT OR IGNORE INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) SELECT ?,?,?,'failed',?,?,?,? WHERE EXISTS(SELECT 1 FROM ${scheduleTable(row.kind)} WHERE account_id=? AND kind=? AND enabled=1 AND next_at=?)`,
			)
			.bind(
				run.id,
				row.account_id,
				run.requestKey,
				JSON.stringify(run),
				now,
				now,
				now,
				row.account_id,
				row.kind,
				row.next_at,
			),
		advanceSchedule(db, row, run),
	]);
	return Boolean(result[1]?.meta.changes);
}

async function scheduleError(raw: D1Database, row: DueSchedule, error: string) {
	await createDb(raw)
		.prepare(
			`UPDATE ${scheduleTable(row.kind)} SET last_error=CASE WHEN last_error IN ('run_timed_out','scheduled_slots_missed','scheduled_slot_missed') THEN last_error ELSE ? END WHERE account_id=? AND kind=? AND enabled=1 AND next_at=?`,
		)
		.bind(error, row.account_id, row.kind, row.next_at)
		.run();
}

async function normalizePending(
	raw: D1Database,
	original: DueSchedule,
	owner: string,
	now: string,
) {
	let row = original;
	for (let settled = 0; settled < 32 && row.next_at <= now; settled++) {
		const db = createDb(raw);
		const accepted = await db
			.prepare(
				"SELECT id,json_extract(payload,'$.error') AS error FROM factory_runs WHERE account_id=? AND request_key=?",
			)
			.bind(row.account_id, `${row.kind}:${row.next_at}`)
			.first<{ id: string; error: string | null }>();
		let advanced = false;
		if (accepted)
			advanced = Boolean(
				(
					await advanceSchedule(db, row, {
						id: accepted.id,
						...(accepted.error ? { error: accepted.error } : {}),
					}).run()
				).meta.changes,
			);
		else if (row.kind !== "weekly" && row.next_at < beijingDayStart(now))
			advanced = await recordFailure(raw, row, owner, now, "scheduled_slot_missed");
		else return;
		if (!advanced) return;
		row = {
			...row,
			next_at: nextScheduleAt(row.kind, JSON.parse(row.times), row.weekday, row.next_at),
		};
	}
	if (row.next_at <= now) await scheduleError(raw, row, "schedule_backlog");
}

export async function readSchedules(db: Db, account: string): Promise<RefreshSchedule[]> {
	return decodeSchedules((await schedulesStatement(db, account).all<ScheduleRow>()).results);
}
export function schedulesStatement(db: Db, account: string): D1PreparedStatement {
	return db.prepare(`${scheduleRows} WHERE account_id=?`).bind(account);
}
export function decodeSchedules(rows: ScheduleRow[]): RefreshSchedule[] {
	return (["daily", "weekly", "catalog"] as const).map((kind) => {
		const row = rows.find((item) => item.kind === kind);
		return row
			? {
					kind,
					enabled: row.enabled === 1,
					time: row.time,
					times: JSON.parse(row.times),
					weekday: row.weekday,
					scope: row.scope,
					nextAt: row.next_at,
					lastRunId: row.last_run_id,
					lastError: row.last_error,
				}
			: { kind, ...defaultSchedule(kind), nextAt: null, lastRunId: null, lastError: null };
	});
}
export async function saveSchedule(
	db: Db,
	account: string,
	kind: ScheduleKind,
	config: ScheduleConfig,
	now: string,
): Promise<void> {
	const normalized = normalizeScheduleConfig(config);
	await db.batch([
		db
			.prepare(
				`INSERT INTO ${kind === "catalog" ? "catalog_refresh_schedules" : "refresh_schedules"}(account_id,kind,enabled,time,weekday,scope,next_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,kind) DO UPDATE SET enabled=excluded.enabled,time=excluded.time,weekday=excluded.weekday,scope=excluded.scope,next_at=excluded.next_at,last_error=NULL`,
			)
			.bind(
				account,
				kind,
				Number(config.enabled),
				normalized.time,
				config.weekday,
				config.scope,
				nextScheduleAt(kind, normalized.times, config.weekday, now),
			),
		db
			.prepare("UPDATE refresh_schedule_times SET times=? WHERE account_id=? AND kind=?")
			.bind(JSON.stringify(normalized.times), account, kind),
	]);
}
export async function starredRepos(db: Db, account: string): Promise<string[]> {
	const rows = await starredReposStatement(db, account).all<{ repo: string }>();
	return rows.results.map((r) => r.repo);
}
export function starredReposStatement(db: Db, account: string): D1PreparedStatement {
	return db
		.prepare("SELECT repo FROM repo_stars WHERE account_id=? AND starred=1 ORDER BY repo")
		.bind(account);
}
export async function readScheduleSettings(db: Db, account: string) {
	const results = await db.batch([
		schedulesStatement(db, account),
		starredReposStatement(db, account),
	]);
	const schedules = results[0];
	const stars = results[1];
	if (!schedules || !stars) throw new ApiError(500, "db_error", "incomplete settings batch");
	return {
		schedules: decodeSchedules(schedules.results as ScheduleRow[]),
		stars: (stars.results as { repo: string }[]).map((row) => row.repo),
	};
}
export async function enableDefaultSchedules(db: Db, account: string, now: string): Promise<void> {
	for (const kind of ["daily", "weekly"] as const) {
		const config = defaultSchedule(kind);
		await db
			.prepare(
				"INSERT INTO refresh_schedules(account_id,kind,enabled,time,weekday,scope,next_at) VALUES(?,?,1,?,?,?,?) ON CONFLICT(account_id,kind) DO NOTHING",
			)
			.bind(
				account,
				kind,
				config.time,
				config.weekday,
				config.scope,
				nextScheduleAt(kind, config.time, config.weekday, now),
			)
			.run();
	}
}
export async function scheduleRefreshes(
	raw: D1Database,
	now: string,
	accountId = "",
	clock = () => now,
): Promise<void> {
	await expireRuns(createDb(raw), now, accountId);
	const due = await createDb(raw)
		.prepare(
			`${scheduleRows} WHERE enabled=1 AND next_at<=? AND (?='' OR account_id=?) ORDER BY next_at,kind DESC`,
		)
		.bind(now, accountId, accountId)
		.all<DueSchedule>();
	for (const row of due.results) {
		try {
			const account = await getAccount(createDb(raw), row.account_id);
			if (account) await normalizePending(raw, row, account.login, now);
		} catch (error) {
			await scheduleError(raw, row, error instanceof ApiError ? error.code : "internal_error");
		}
	}
	const accounts = [...new Set(due.results.map((row) => row.account_id))];
	for (const id of accounts) {
		const candidates = await createDb(raw)
			.prepare(
				`WITH pending AS (${scheduleRows} WHERE account_id=? AND enabled=1 AND next_at<=? AND (kind='weekly' OR next_at>=?)) SELECT * FROM pending ORDER BY ${SCHEDULE_PRIORITY}`,
			)
			.bind(id, now, beijingDayStart(now))
			.all<DueSchedule>();
		for (const row of candidates.results) {
			const db = createDb(raw);
			try {
				const account = await getAccount(db, row.account_id);
				if (!account) continue;
				let repos: string[] = [];
				if (row.kind !== "catalog") {
					let catalog = await catalogFactory(db, account.id);
					let policy = await repoPolicy(db, account.id, undefined, row.scope);
					const ready = () =>
						catalog?.inventory.complete &&
						Date.parse(now) - Date.parse(catalog.fetched_at) < 86400_000 &&
						policy.repos.every((repo) =>
							catalog?.repos.some((entry) => entry.name === repo.name_with_owner),
						);
					if (!ready()) {
						const preparation = await startRefresh(
							db,
							account,
							{
								account_id: account.id,
								requestKey: `${row.kind}:${row.next_at}:catalog`,
								mode: "catalog",
								depth: "quick",
								scope: "all",
							},
							now,
							row.kind,
							{ kind: row.kind, dueAt: row.next_at },
							clock,
						);
						if (["running", "paused"].includes(preparation.status)) {
							await scheduleError(raw, row, "catalog_pending");
							continue;
						}
						if (preparation.status === "completed") {
							catalog = await catalogFactory(db, account.id);
							policy = await repoPolicy(db, account.id, undefined, row.scope);
						}
						if (!ready()) {
							await recordFailure(raw, row, account.login, clock(), "catalog_preparation_failed");
							continue;
						}
					}
					repos = policy.repos.map((repo) => repo.name_with_owner);
				}
				if (row.kind !== "catalog" && !repos.length) {
					await recordFailure(raw, row, account.login, clock(), "no_starred_repositories");
					continue;
				}
				const run = await startRefresh(
					db,
					account,
					{
						account_id: account.id,
						requestKey: `${row.kind}:${row.next_at}`,
						mode: row.kind === "catalog" ? "catalog" : "refresh",
						depth: row.kind === "weekly" ? "deep" : "quick",
						scope: row.scope === "all" ? "all" : "selected",
						...(row.scope === "starred" ? { repos } : {}),
					},
					now,
					row.kind === "weekly" ? "weekly" : "daily",
					{ kind: row.kind, dueAt: row.next_at },
					clock,
				);
				await advanceSchedule(db, row, run).run();
			} catch (error) {
				await scheduleError(raw, row, error instanceof ApiError ? error.code : "internal_error");
			}
		}
	}
}
