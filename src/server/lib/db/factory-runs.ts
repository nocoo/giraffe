import {
	type FactoryRun,
	type RepoRefreshState,
	RUN_COOLDOWN_MS,
	RUN_LEASE_MS,
} from "../../../lib/factory-run";
import type { FactorySnapshot } from "../../../lib/factory-types";
import { ApiError } from "../errors";
import type { Db } from "./d1";
import { readSnapshot } from "./snapshots";

type RunRow = {
	payload: string;
	lease_token: string | null;
	lease_until: string | null;
	version: number;
};
export type RunLease = { run: FactoryRun; token: string; version: number; leaseUntil: string };
export type FactoryHead = {
	published_id: string | null;
	catalog_id: string | null;
	next_at: string;
};
const parse = (row: RunRow) => ({
	run: JSON.parse(row.payload) as FactoryRun,
	leaseUntil: row.lease_until,
});
export async function getRun(db: Db, account: string, id: string) {
	const row = await db
		.prepare("SELECT payload,lease_until FROM factory_runs WHERE account_id=? AND id=?")
		.bind(account, id)
		.first<RunRow>();
	return row ? parse(row) : null;
}
export async function listRuns(db: Db, account: string, detail = "") {
	const rows = await db
		.prepare(`SELECT
 CASE WHEN status IN ('running','paused') OR id=COALESCE(NULLIF(?,''),(SELECT id FROM factory_runs WHERE account_id=? ORDER BY created_at DESC LIMIT 1)) THEN json_remove(payload,'$.checkpoint') ELSE json_remove(payload,'$.checkpoint','$.steps') END AS payload,
 lease_until,json_array_length(payload,'$.steps') AS total,
 (SELECT COUNT(*) FROM json_each(payload,'$.steps') WHERE json_extract(value,'$.status')='success') AS success,
 (SELECT COUNT(*) FROM json_each(payload,'$.steps') WHERE json_extract(value,'$.status')='failed') AS failed,
 (SELECT COUNT(*) FROM json_each(payload,'$.steps') WHERE json_extract(value,'$.status')='skipped') AS skipped
 FROM factory_runs WHERE account_id=? ORDER BY CASE WHEN status IN ('running','paused') THEN 0 ELSE 1 END,created_at DESC LIMIT 21`)
		.bind(detail, account, account)
		.all<RunRow & { total: number; success: number; failed: number; skipped: number }>();
	return rows.results.map((row) => {
		const entry = parse(row);
		entry.run.steps ??= [];
		return {
			...entry,
			counts: { total: row.total, success: row.success, failed: row.failed, skipped: row.skipped },
		};
	});
}
export const factoryHead = (db: Db, account: string) =>
	db
		.prepare("SELECT published_id,catalog_id,next_at FROM factory_state WHERE account_id=?")
		.bind(account)
		.first<FactoryHead>();
export async function publishedFactory(db: Db, account: string): Promise<FactorySnapshot | null> {
	const head = await factoryHead(db, account);
	return (await readSnapshot(
		db,
		account,
		head?.published_id ? `factory:v:${head.published_id}` : "factory",
	)) as FactorySnapshot | null;
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
export async function startRun(db: Db, run: FactoryRun): Promise<FactoryRun> {
	const old = await db
		.prepare("SELECT payload FROM factory_runs WHERE account_id=? AND request_key=?")
		.bind(run.account_id, run.requestKey)
		.first<{ payload: string }>();
	if (old) return JSON.parse(old.payload) as FactoryRun;
	const inserted = await db
		.prepare(`INSERT OR IGNORE INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at)
 SELECT ?,?,?,'running',?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM factory_runs WHERE account_id=? AND status IN ('running','paused'))
 AND NOT EXISTS(SELECT 1 FROM factory_runs WHERE account_id=? AND created_at>?)
 AND NOT EXISTS(SELECT 1 FROM factory_state WHERE account_id=? AND next_at>?)
 AND NOT EXISTS(SELECT 1 FROM snapshots WHERE account_id=? AND kind='factory:lock' AND fetched_at>?)`)
		.bind(
			run.id,
			run.account_id,
			run.requestKey,
			JSON.stringify(run),
			run.startedAt,
			run.startedAt,
			run.startedAt,
			run.account_id,
			run.account_id,
			new Date(Date.parse(run.startedAt) - RUN_COOLDOWN_MS).toISOString(),
			run.account_id,
			run.startedAt,
			run.account_id,
			run.startedAt,
		)
		.run();
	if (!inserted.meta.changes) {
		const duplicate = await db
			.prepare("SELECT payload FROM factory_runs WHERE account_id=? AND request_key=?")
			.bind(run.account_id, run.requestKey)
			.first<{ payload: string }>();
		if (duplicate) return JSON.parse(duplicate.payload) as FactoryRun;
		const active = await db
			.prepare("SELECT id FROM factory_runs WHERE account_id=? AND status IN ('running','paused')")
			.bind(run.account_id)
			.first();
		throw new ApiError(
			409,
			active ? "account_conflict" : "refresh_cooldown",
			active ? "a run already exists" : "refresh cooldown; read nextAllowedAt",
		);
	}
	// Account cooldown is also derived from created_at on subsequent starts; persist a UI hint.
	await db
		.prepare(
			"INSERT INTO factory_state(account_id,next_at) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET next_at=MAX(next_at,excluded.next_at)",
		)
		.bind(run.account_id, new Date(Date.parse(run.startedAt) + RUN_COOLDOWN_MS).toISOString())
		.run();
	return run;
}
export async function claimRun(db: Db, id: string, now: string): Promise<RunLease | null> {
	const token = crypto.randomUUID();
	const until = new Date(Date.parse(now) + RUN_LEASE_MS).toISOString();
	const row = await db
		.prepare(
			"UPDATE factory_runs SET lease_token=?,lease_until=?,updated_at=?,payload=json_set(payload,'$.updatedAt',?,'$.version',version+1,'$.steps[' || json_extract(payload,'$.cursor') || '].status','running','$.steps[' || json_extract(payload,'$.cursor') || '].startedAt',COALESCE(json_extract(payload,'$.steps[' || json_extract(payload,'$.cursor') || '].startedAt'),?)),version=version+1 WHERE id=? AND status='running' AND next_at<=? AND (lease_until IS NULL OR lease_until<=?) RETURNING payload,version",
		)
		.bind(token, until, now, now, now, id, now, now)
		.first<RunRow>();
	return row
		? { run: JSON.parse(row.payload) as FactoryRun, token, version: row.version, leaseUntil: until }
		: null;
}
export function fenced(
	db: Db,
	lease: RunLease,
	now: string,
	sql: string,
	values: unknown[] = [],
): D1PreparedStatement {
	const guard =
		"EXISTS(SELECT 1 FROM factory_runs WHERE id=? AND lease_token=? AND version=? AND lease_until>? AND status='running')";
	return db
		.prepare(sql.replace("$guard", guard))
		.bind(...values, lease.run.id, lease.token, lease.version, now);
}
export async function saveRun(
	db: Db,
	lease: RunLease,
	writes: D1PreparedStatement[],
	now: string,
): Promise<boolean> {
	const run = lease.run;
	run.updatedAt = now;
	run.version = lease.version + 1;
	const result = await db.batch([
		...writes,
		fenced(
			db,
			lease,
			now,
			"UPDATE factory_runs SET payload=?,status=?,version=version+1,updated_at=?,next_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND $guard",
			[JSON.stringify(run), run.status, now, run.nextAttemptAt, run.id],
		),
	]);
	return Boolean(result.at(-1)?.meta.changes);
}
export async function controlRun(
	db: Db,
	account: string,
	id: string,
	action: "pause" | "resume" | "cancel",
	now: string,
): Promise<FactoryRun> {
	const found = await getRun(db, account, id);
	if (!found) throw new ApiError(404, "not_found", "run not found");
	const run = found.run;
	if (!["running", "paused"].includes(run.status)) return run;
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
	// Resume must preserve rate-limit/backoff deadlines.
	const result = await db
		.prepare(
			"UPDATE factory_runs SET status=?,payload=?,version=version+1,lease_token=NULL,lease_until=NULL,updated_at=? WHERE account_id=? AND id=? AND version=? AND status IN ('running','paused')",
		)
		.bind(
			run.status,
			JSON.stringify({ ...run, version: run.version + 1 }),
			now,
			account,
			id,
			run.version,
		)
		.run();
	if (!result.meta.changes) throw new ApiError(409, "account_conflict", "run changed; reload");
	return { ...run, version: run.version + 1 };
}
export async function dueRuns(db: Db, now: string) {
	const result = await db
		.prepare(
			"SELECT id FROM factory_runs WHERE status='running' AND next_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_at LIMIT 5",
		)
		.bind(now, now)
		.all<{ id: string }>();
	return result.results.map((r) => r.id);
}
