import type { RefreshParams, RefreshRun } from "../../lib/refresh-types";
import type { Db } from "./db/d1";
import { createId } from "./id";

type Row = { payload: string };
const decode = (row: Row | null): RefreshRun | null =>
	row ? (JSON.parse(row.payload) as RefreshRun) : null;
export async function getRefreshRun(db: Db, account: string, id: string) {
	return decode(
		await db
			.prepare("SELECT payload FROM refresh_runs WHERE account_id=? AND id=?")
			.bind(account, id)
			.first<Row>(),
	);
}
export async function activeRefreshRun(db: Db, account: string) {
	return decode(
		await db
			.prepare(
				"SELECT payload FROM refresh_runs WHERE account_id=? AND status IN ('queued','running') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,created_at,id LIMIT 1",
			)
			.bind(account)
			.first<Row>(),
	);
}
export async function scheduledRefreshRun(db: Db, account: string, day: string) {
	return decode(
		await db
			.prepare(
				"SELECT payload FROM refresh_runs WHERE account_id=? AND trigger='scheduled' AND schedule_day=?",
			)
			.bind(account, day)
			.first<Row>(),
	);
}
export async function listRefreshRuns(db: Db, account: string) {
	const rows = await db
		.prepare(
			"SELECT payload FROM refresh_runs WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT 50",
		)
		.bind(account)
		.all<Row>();
	return rows.results.map((row) => JSON.parse(row.payload) as RefreshRun);
}
export async function createRefreshRun(
	db: Db,
	accountId: string,
	params: RefreshParams,
	trigger: RefreshRun["trigger"],
	now: string,
	scheduleDay: string | null = null,
): Promise<RefreshRun> {
	const run: RefreshRun = {
		id: createId(),
		accountId,
		params,
		trigger,
		status: "queued",
		phase: "account",
		repos: [],
		completedRepos: 0,
		requests: 0,
		partial: false,
		errorCode: null,
		createdAt: now,
		updatedAt: now,
		finishedAt: null,
	};
	await db
		.prepare(
			"INSERT INTO refresh_runs(id,account_id,status,trigger,schedule_day,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
		)
		.bind(run.id, accountId, run.status, trigger, scheduleDay, JSON.stringify(run), now, now)
		.run();
	return run;
}
export async function saveRefreshRun(db: Db, run: RefreshRun): Promise<void> {
	await db
		.prepare("UPDATE refresh_runs SET status=?,payload=?,updated_at=? WHERE account_id=? AND id=?")
		.bind(run.status, JSON.stringify(run), run.updatedAt, run.accountId, run.id)
		.run();
}
