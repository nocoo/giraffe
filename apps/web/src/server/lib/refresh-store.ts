import type { RefreshParams, RefreshRun } from "../../lib/refresh-types";
import type { Db } from "./db/d1";
import { createId } from "./id";

type Row = { payload: string };
export type RequestCounts = { graphql: number; rest: number };
const decode = (row: Row | null): RefreshRun | null =>
	row ? (JSON.parse(row.payload) as RefreshRun) : null;
export const terminalRefreshStatus = (status: RefreshRun["status"]): boolean =>
	status !== "queued" && status !== "running";
export const emptyRequestBreakdown = (): RefreshRun["requestBreakdown"] => ({
	total: 0,
	graphql: 0,
	rest: 0,
	a: { graphql: 0, rest: 0 },
	b: { graphql: 0, rest: 0 },
});
export function addRefreshRequests(
	run: RefreshRun,
	scope: "a" | "b",
	counts: RequestCounts,
): RefreshRun {
	const accountCounts =
		scope === "a"
			? {
					graphql: run.requestBreakdown.a.graphql + counts.graphql,
					rest: run.requestBreakdown.a.rest + counts.rest,
				}
			: run.requestBreakdown.a;
	const repositoryCounts =
		scope === "b"
			? {
					graphql: run.requestBreakdown.b.graphql + counts.graphql,
					rest: run.requestBreakdown.b.rest + counts.rest,
				}
			: run.requestBreakdown.b;
	const graphql = accountCounts.graphql + repositoryCounts.graphql;
	const rest = accountCounts.rest + repositoryCounts.rest;
	return {
		...run,
		requests: graphql + rest,
		requestBreakdown: {
			total: graphql + rest,
			graphql,
			rest,
			a: accountCounts,
			b: repositoryCounts,
		},
	};
}
export function addRefreshPartialReasons(
	run: RefreshRun,
	repo: string | null,
	codes: string[],
): RefreshRun {
	if (!codes.length) return run;
	const existing = run.partialReasons.find((entry) => entry.repo === repo);
	if (!existing)
		return {
			...run,
			partialReasons: [...run.partialReasons, { repo, codes: [...new Set(codes)].sort() }],
		};
	const merged = [...new Set([...existing.codes, ...codes])].sort();
	return {
		...run,
		partialReasons: run.partialReasons.map((entry) =>
			entry.repo === repo ? { repo, codes: merged } : entry,
		),
	};
}
export function cancelRefreshRun(run: RefreshRun, at: string): RefreshRun {
	if (terminalRefreshStatus(run.status)) return run;
	return {
		...run,
		status: "cancelled",
		phase: "done",
		cancelRequested: true,
		updatedAt: at,
		finishedAt: at,
	};
}
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
		requestBreakdown: emptyRequestBreakdown(),
		partialReasons: [],
		partial: false,
		cancelRequested: false,
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
