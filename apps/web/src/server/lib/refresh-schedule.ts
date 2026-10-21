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
import { repoPolicy, statisticsFactory } from "./repo-statistics";

export function nextScheduleAt(
	kind: ScheduleKind,
	time: string,
	weekday: number,
	now: string,
): string {
	const local = new Date(Date.parse(now) + 8 * 3600000);
	const [hour, minute] = time.split(":").map(Number);
	local.setUTCHours(hour ?? 0, minute ?? 0, 0, 0);
	if (kind === "weekly")
		local.setUTCDate(local.getUTCDate() + ((weekday - local.getUTCDay() + 7) % 7));
	if (local.getTime() - 8 * 3600000 <= Date.parse(now))
		local.setUTCDate(local.getUTCDate() + (kind === "weekly" ? 7 : 1));
	return new Date(local.getTime() - 8 * 3600000).toISOString();
}
type ScheduleRow = {
	kind: ScheduleKind;
	enabled: number;
	time: string;
	weekday: number;
	scope: "all" | "starred";
	next_at: string;
	last_run_id: string | null;
	last_error: string | null;
};
type DueSchedule = ScheduleRow & { account_id: string };
const scheduleTable = (kind: ScheduleKind) =>
	kind === "catalog" ? "catalog_refresh_schedules" : "refresh_schedules";

function skippedRun(row: DueSchedule, owner: string, now: string, error: string): FactoryRun {
	const run = makeRun(
		crypto.randomUUID(),
		row.account_id,
		owner,
		`${row.kind}:${row.next_at}:skipped`,
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
	};
}

function skippedRunInsert(db: Db, row: DueSchedule, run: FactoryRun): D1PreparedStatement {
	return db
		.prepare(
			`INSERT OR IGNORE INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) SELECT ?,?,?,'failed',?,?,?,? WHERE EXISTS(SELECT 1 FROM ${scheduleTable(row.kind)} WHERE account_id=? AND kind=? AND enabled=1 AND next_at=?)`,
		)
		.bind(
			run.id,
			row.account_id,
			run.requestKey,
			JSON.stringify(run),
			run.startedAt,
			run.startedAt,
			run.startedAt,
			row.account_id,
			row.kind,
			row.next_at,
		);
}

async function coalesceMissedSlots(
	db: Db,
	row: DueSchedule,
	owner: string,
	now: string,
): Promise<boolean> {
	const period = (row.kind === "weekly" ? 7 : 1) * 86400_000;
	const accepted = await db
		.prepare("SELECT id FROM factory_runs WHERE account_id=? AND request_key=?")
		.bind(row.account_id, `${row.kind}:${row.next_at}`)
		.first<{ id: string }>();
	if (accepted) {
		const next = new Date(Date.parse(row.next_at) + period).toISOString();
		const result = await db
			.prepare(
				`UPDATE ${scheduleTable(row.kind)} SET next_at=?,last_run_id=? WHERE account_id=? AND kind=? AND enabled=1 AND next_at=?`,
			)
			.bind(next, accepted.id, row.account_id, row.kind, row.next_at)
			.run();
		if (!result.meta.changes || next > now) return false;
		row.next_at = next;
	}
	const count = Math.floor((Date.parse(now) - Date.parse(row.next_at)) / period);
	if (count === 0) return true;
	const latest = new Date(Date.parse(row.next_at) + count * period).toISOString();
	const run = skippedRun(row, owner, now, "scheduled_slots_missed");
	run.missedSlots = {
		firstDueAt: row.next_at,
		lastDueAt: new Date(Date.parse(latest) - period).toISOString(),
		count,
	};
	const results = await db.batch([
		skippedRunInsert(db, row, run),
		db
			.prepare(
				`UPDATE ${scheduleTable(row.kind)} SET next_at=?,last_error='scheduled_slots_missed' WHERE account_id=? AND kind=? AND enabled=1 AND next_at=? AND EXISTS(SELECT 1 FROM factory_runs WHERE account_id=? AND request_key=? AND json_extract(payload,'$.missedSlots.lastDueAt')=?)`,
			)
			.bind(
				latest,
				row.account_id,
				row.kind,
				row.next_at,
				row.account_id,
				run.requestKey,
				run.missedSlots.lastDueAt,
			),
	]);
	if (!results[1]?.meta.changes) return false;
	row.next_at = latest;
	return true;
}
export async function readSchedules(db: Db, account: string): Promise<RefreshSchedule[]> {
	const rows = await db
		.prepare(
			"SELECT * FROM (SELECT * FROM refresh_schedules UNION ALL SELECT * FROM catalog_refresh_schedules) WHERE account_id=?",
		)
		.bind(account)
		.all<ScheduleRow>();
	return (["daily", "weekly", "catalog"] as const).map((kind) => {
		const row = rows.results.find((r) => r.kind === kind);
		return row
			? {
					kind,
					enabled: row.enabled === 1,
					time: row.time,
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
	await db
		.prepare(
			`INSERT INTO ${kind === "catalog" ? "catalog_refresh_schedules" : "refresh_schedules"}(account_id,kind,enabled,time,weekday,scope,next_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,kind) DO UPDATE SET enabled=excluded.enabled,time=excluded.time,weekday=excluded.weekday,scope=excluded.scope,next_at=excluded.next_at,last_error=NULL`,
		)
		.bind(
			account,
			kind,
			Number(config.enabled),
			config.time,
			config.weekday,
			config.scope,
			nextScheduleAt(kind, config.time, config.weekday, now),
		)
		.run();
}
export async function starredRepos(db: Db, account: string): Promise<string[]> {
	const rows = await db
		.prepare("SELECT repo FROM repo_stars WHERE account_id=? ORDER BY repo")
		.bind(account)
		.all<{ repo: string }>();
	return rows.results.map((r) => r.repo);
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
export async function scheduleRefreshes(raw: D1Database, now: string): Promise<void> {
	await expireRuns(createDb(raw), now);
	const due = await createDb(raw)
		.prepare(
			"SELECT * FROM (SELECT * FROM refresh_schedules UNION ALL SELECT * FROM catalog_refresh_schedules) WHERE enabled=1 AND next_at<=? ORDER BY next_at,kind DESC LIMIT 10",
		)
		.bind(now)
		.all<DueSchedule>();
	for (const row of due.results) {
		const db = createDb(raw);
		let runId: string | null = null;
		let error: string | null = null;
		let advance = false;
		let skipped: FactoryRun | null = null;
		try {
			const account = await getAccount(db, row.account_id);
			if (!account) continue;
			if (!(await coalesceMissedSlots(db, row, account.login, now))) continue;
			let repos: string[] = [];
			if (row.kind !== "catalog") {
				const catalog = await catalogFactory(db, account.id);
				if (
					!catalog?.inventory.complete ||
					Date.parse(now) - Date.parse(catalog.fetched_at) >= 86400_000
				) {
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
					);
					advance = !["running", "paused"].includes(preparation.status);
					throw new ApiError(
						409,
						preparation.status === "running" || preparation.status === "paused"
							? "catalog_pending"
							: "catalog_incomplete",
						"scheduled catalogue preparation",
					);
				}
				const policy = await repoPolicy(db, account.id);
				const stars = new Set(
					(await starredRepos(db, account.id)).map((name) => name.toLowerCase()),
				);
				repos =
					row.scope === "all"
						? statisticsFactory(catalog, policy).repos.map((repo) => repo.name)
						: policy.repos
								.filter((repo) => stars.has(repo.name_with_owner.toLowerCase()))
								.map((repo) => repo.name_with_owner);
			}
			if (row.kind !== "catalog" && !repos.length) {
				error = "no_starred_repositories";
				advance = true;
				skipped = skippedRun(row, account.login, now, error);
			} else {
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
				);
				runId = run.id;
				advance = true;
			}
		} catch (e) {
			error = e instanceof ApiError ? e.code : "internal_error";
		}
		const update = db
			.prepare(
				`UPDATE ${scheduleTable(row.kind)} SET next_at=?,last_run_id=COALESCE(?,last_run_id),last_error=CASE WHEN last_error IN ('run_timed_out','scheduled_slots_missed') THEN last_error ELSE ? END WHERE account_id=? AND kind=? AND enabled=1 AND next_at=?`,
			)
			.bind(
				advance ? nextScheduleAt(row.kind, row.time, row.weekday, now) : row.next_at,
				runId ?? skipped?.id ?? null,
				error,
				row.account_id,
				row.kind,
				row.next_at,
			);
		await db.batch([...(skipped ? [skippedRunInsert(db, row, skipped)] : []), update]);
	}
}
