import {
	type FactoryRun,
	REPO_COOLDOWN_MS,
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
export type RunLease = {
	run: FactoryRun;
	token: string;
	version: number;
	leaseUntil: string;
	extraBytes?: number;
	storedBytes?: number;
	fenceAt?: string;
};
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
	const insert = db
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
	return run;
}
export async function claimRun(db: Db, id: string, now: string): Promise<RunLease | null> {
	const token = crypto.randomUUID();
	const until = new Date(Date.parse(now) + RUN_LEASE_MS).toISOString();
	const row = await db
		.prepare(
			"UPDATE factory_runs SET lease_token=?,lease_until=?,updated_at=?,payload=json_set(payload,'$.updatedAt',?,'$.version',version+1),version=version+1 WHERE id=? AND status='running' AND next_at<=? AND (lease_until IS NULL OR lease_until<=?) RETURNING payload,version",
		)
		.bind(token, until, now, now, id, now, now)
		.first<RunRow>();
	return row
		? {
				run: JSON.parse(row.payload) as FactoryRun,
				token,
				version: row.version,
				leaseUntil: until,
				extraBytes: 0,
				storedBytes: new TextEncoder().encode(row.payload).length,
			}
		: null;
}
export function fenced(
	db: Db,
	lease: RunLease,
	now: string,
	sql: string,
	values: unknown[] = [],
): D1PreparedStatement {
	lease.fenceAt = lease.fenceAt && lease.fenceAt > now ? lease.fenceAt : now;
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
	const expiresAfter = lease.fenceAt && lease.fenceAt > now ? lease.fenceAt : now;
	const validSql =
		"SELECT 1 FROM factory_runs WHERE id=? AND lease_token=? AND version=? AND lease_until>? AND status='running'";
	const args = [run.id, lease.token, lease.version, expiresAfter];
	try {
		const result = await db.batch([
			// A failed final CAS must not leave earlier writes committed. Abort the transaction first.
			db.prepare(`SELECT CASE WHEN EXISTS(${validSql}) THEN 1 ELSE json('{') END`).bind(...args),
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
	const writes: D1PreparedStatement[] = [];
	const current = run.steps[run.cursor];
	if (
		action !== "resume" &&
		current?.repo &&
		current.kind !== "snapshot" &&
		current.kind !== "assessment" &&
		run.steps.some((s) => s.repo === current.repo && s.startedAt)
	) {
		const prior = await db
			.prepare("SELECT version,payload FROM factory_repo_state WHERE account_id=? AND repo=?")
			.bind(account, current.repo)
			.first<{ version: string | null; payload: string }>();
		const state: RepoRefreshState = prior
			? (JSON.parse(prior.payload) as RepoRefreshState)
			: { repo: current.repo, status: "partial", refreshedAt: null, nextAllowedAt: now };
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
					current.repo,
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
			JSON.stringify({ ...run, version: run.version + 1 }),
			now,
			account,
			id,
			run.version,
		);
	const results = await db.batch([...writes, update]);
	const result = results.at(-1);

	if (!result?.meta.changes) throw new ApiError(409, "account_conflict", "run changed; reload");
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
