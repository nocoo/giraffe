import {
	defaultSchedule,
	type RefreshSchedule,
	type ScheduleConfig,
	type ScheduleKind,
} from "../../lib/refresh-schedule";
import { getAccount } from "./db/accounts";
import { createDb, type Db } from "./db/d1";
import { catalogFactory } from "./db/factory-runs";
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
		local.setUTCDate(local.getUTCDate() + (kind === "daily" ? 1 : 7));
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
export async function readSchedules(db: Db, account: string): Promise<RefreshSchedule[]> {
	const rows = await db
		.prepare("SELECT * FROM refresh_schedules WHERE account_id=?")
		.bind(account)
		.all<ScheduleRow>();
	return (["daily", "weekly"] as const).map((kind) => {
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
			"INSERT INTO refresh_schedules(account_id,kind,enabled,time,weekday,scope,next_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,kind) DO UPDATE SET enabled=excluded.enabled,time=excluded.time,weekday=excluded.weekday,scope=excluded.scope,next_at=excluded.next_at,last_error=NULL",
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
	const due = await createDb(raw)
		.prepare(
			"SELECT * FROM refresh_schedules WHERE enabled=1 AND next_at<=? ORDER BY next_at,kind DESC LIMIT 10",
		)
		.bind(now)
		.all<ScheduleRow & { account_id: string }>();
	for (const row of due.results) {
		const db = createDb(raw);
		let runId: string | null = null;
		let error: string | null = null;
		let advance = false;
		try {
			const account = await getAccount(db, row.account_id);
			if (!account) continue;
			const catalog = await catalogFactory(db, account.id);
			if (!catalog?.inventory.complete)
				throw new ApiError(409, "catalog_incomplete", "catalog incomplete");
			const policy = await repoPolicy(db, account.id);
			const stars = new Set((await starredRepos(db, account.id)).map((name) => name.toLowerCase()));
			const repos =
				row.scope === "all"
					? statisticsFactory(catalog, policy).repos.map((repo) => repo.name)
					: policy.repos
							.filter((repo) => stars.has(repo.name_with_owner.toLowerCase()))
							.map((repo) => repo.name_with_owner);
			if (!repos.length) {
				error = "no_starred_repositories";
				advance = true;
			} else {
				const run = await startRefresh(
					db,
					account,
					{
						account_id: account.id,
						requestKey: `${row.kind}:${row.next_at}`,
						mode: "refresh",
						depth: row.kind === "daily" ? "quick" : "deep",
						scope: row.scope === "all" ? "all" : "selected",
						...(row.scope === "starred" ? { repos } : {}),
					},
					now,
					row.kind,
					{ kind: row.kind, dueAt: row.next_at },
				);
				runId = run.id;
				advance = true;
			}
		} catch (e) {
			error = e instanceof ApiError ? e.code : "internal_error";
		}
		await db
			.prepare(
				"UPDATE refresh_schedules SET next_at=?,last_run_id=COALESCE(?,last_run_id),last_error=? WHERE account_id=? AND kind=? AND enabled=1 AND next_at=?",
			)
			.bind(
				advance ? nextScheduleAt(row.kind, row.time, row.weekday, now) : row.next_at,
				runId,
				error,
				row.account_id,
				row.kind,
				row.next_at,
			)
			.run();
	}
}
