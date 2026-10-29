import type {
	RefreshFailureDetail,
	RefreshParams,
	RefreshRun,
	RefreshRunTimings,
	RefreshStepTiming,
} from "../../lib/refresh-types";
import type { Db } from "./db/d1";
import { createId } from "./id";

type Row = { payload: string };
export type RequestCounts = { graphql: number; rest: number };
const decode = (row: Row | null): RefreshRun | null =>
	row ? (JSON.parse(row.payload) as RefreshRun) : null;
export const terminalRefreshStatus = (status: RefreshRun["status"]): boolean =>
	status !== "queued" && status !== "running";
export const emptyRefreshTimings = (at: string): RefreshRunTimings => ({
	queuedAt: at,
	a: null,
	repos: [],
});
const stepTiming = (startedAt: string): RefreshStepTiming => ({
	startedAt,
	finishedAt: null,
	attempts: 0,
});
const replaced = <Value>(items: Value[], index: number, next: Value): Value[] =>
	items.map((item, position) => (position === index ? next : item));
export function startRefreshStep(run: RefreshRun, at: string): RefreshRun {
	const timings = run.timings;
	if (!timings) return run;
	if (run.phase === "account") {
		if (timings.a) return run;
		return { ...run, timings: { ...timings, a: { ...stepTiming(at), reused: false } } };
	}
	const index = run.completedRepos;
	const repo = run.repos[index];
	const current = timings.repos[index];
	if (!repo || current?.repo === repo) return run;
	const next: RefreshStepTiming & { repo: string } = { repo, ...stepTiming(at) };
	return {
		...run,
		timings: { ...timings, repos: [...timings.repos.slice(0, index), next] },
	};
}
export function completeRefreshStepAttempt(
	run: RefreshRun,
	at: string,
	done: boolean,
	reused = false,
): RefreshRun {
	const timings = run.timings;
	if (!timings) return run;
	const settle = <Entry extends RefreshStepTiming>(entry: Entry): Entry => ({
		...entry,
		attempts: entry.attempts + 1,
		finishedAt: done ? at : null,
	});
	if (run.phase === "account") {
		if (!timings.a) return run;
		return {
			...run,
			timings: { ...timings, a: { ...settle(timings.a), reused: timings.a.reused || reused } },
		};
	}
	const index = run.completedRepos;
	const entry = timings.repos[index];
	if (!entry || entry.repo !== run.repos[index]) return run;
	return { ...run, timings: { ...timings, repos: replaced(timings.repos, index, settle(entry)) } };
}
export function closeRefreshStep(run: RefreshRun, at: string): RefreshRun {
	const timings = run.timings;
	if (!timings) return run;
	if (run.phase === "account")
		return timings.a
			? {
					...run,
					timings: { ...timings, a: { ...timings.a, finishedAt: timings.a.finishedAt ?? at } },
				}
			: run;
	const index = run.completedRepos;
	const entry = timings.repos[index];
	if (!entry || entry.repo !== run.repos[index]) return run;
	return {
		...run,
		timings: {
			...timings,
			repos: replaced(timings.repos, index, { ...entry, finishedAt: entry.finishedAt ?? at }),
		},
	};
}
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
	failures: RefreshFailureDetail[] = [],
): RefreshRun {
	if (!codes.length && !failures.length) return run;
	const existing = run.partialReasons.find((entry) => entry.repo === repo);
	if (!existing)
		return {
			...run,
			partialReasons: [...run.partialReasons, partialReason(repo, codes, [], failures)],
		};
	return {
		...run,
		partialReasons: run.partialReasons.map((entry) =>
			entry.repo === repo
				? partialReason(repo, [...entry.codes, ...codes], entry.failures ?? [], failures)
				: entry,
		),
	};
}
function partialReason(
	repo: string | null,
	codes: string[],
	existing: RefreshFailureDetail[],
	incoming: RefreshFailureDetail[],
) {
	const merged = mergeFailures(existing, incoming);
	return {
		repo,
		codes: [...new Set(codes)].sort(),
		...(merged.length ? { failures: merged } : {}),
	};
}
function mergeFailures(
	existing: RefreshFailureDetail[],
	incoming: RefreshFailureDetail[],
): RefreshFailureDetail[] {
	const merged = new Map(existing.map((failure) => [JSON.stringify(failure), failure]));
	for (const failure of incoming) merged.set(JSON.stringify(failure), failure);
	return [...merged.values()].slice(0, 20);
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
		aReused: false,
		cancelRequested: false,
		errorCode: null,
		createdAt: now,
		updatedAt: now,
		finishedAt: null,
		timings: emptyRefreshTimings(now),
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
		.prepare(
			"UPDATE refresh_runs SET status=?,payload=?,updated_at=?,writer_revision=writer_revision+1 WHERE account_id=? AND id=?",
		)
		.bind(run.status, JSON.stringify(run), run.updatedAt, run.accountId, run.id)
		.run();
}
