import { type FactoryRun, type FactoryRunStep, RUN_LEASE_MS } from "../../../lib/factory-run";
import { RUN_DEADLINE_SQL, runDeadlineAt } from "../factory-timeout";
import type { Db } from "./d1";
import { fenced, type RunLease } from "./factory-runs";

export function applyRunJournal(run: FactoryRun, journal: string, recover = false) {
	const { requests = run.requests, ...steps } = JSON.parse(journal) as Record<
		string,
		FactoryRunStep
	> & { requests?: number };
	run.requests = Math.max(run.requests, requests);
	for (const [index, attempted] of Object.entries(steps)) {
		const step = run.steps[Number(index)];
		if (!step) continue;
		Object.assign(
			step,
			attempted,
			recover
				? {
						status: "pending",
						error: "worker_interrupted",
						retryFailures: (attempted.retryFailures ?? 0) + 1,
					}
				: { status: "running" },
		);
	}
}

export async function beginRunStep(db: Db, lease: RunLease, now: string): Promise<boolean> {
	const step = lease.run.steps[lease.run.cursor];
	if (!step) return false;
	lease.attemptedSteps ??= new Map();
	lease.attemptedSteps.set(
		lease.run.cursor,
		Math.max(lease.attemptedSteps.get(lease.run.cursor) ?? 0, step.retryFailures ?? 0),
	);
	return saveRunAudits(db, lease, now);
}

export async function saveRunAudits(db: Db, lease: RunLease, now: string): Promise<boolean> {
	const audits = Object.fromEntries(
		[...(lease.attemptedSteps ?? [])].map(([index, failures]) => {
			const step = lease.run.steps[index] as FactoryRunStep;
			return [
				index,
				{
					attempts: step.attempts,
					startedAt: step.startedAt,
					durationMs: step.durationMs,
					retryFailures: Math.max(failures, step.retryFailures ?? 0),
				},
			];
		}),
	);
	const result = await fenced(
		db,
		lease,
		now,
		"UPDATE factory_run_journal SET journal=json_patch(journal,json(?)) WHERE run_id=? AND $guard",
		[JSON.stringify({ ...audits, requests: lease.run.requests }), lease.run.id],
	).run();
	return Boolean(result.meta.changes);
}

export async function renewRunLease(db: Db, lease: RunLease, now: string): Promise<boolean> {
	const until = new Date(
		Math.min(Date.parse(now) + RUN_LEASE_MS, Date.parse(runDeadlineAt(lease.run))),
	).toISOString();
	const result = await fenced(
		db,
		lease,
		now,
		`UPDATE factory_runs SET lease_until=MIN(?,${RUN_DEADLINE_SQL}) WHERE id=? AND $guard`,
		[until, lease.run.id],
	).run();
	if (result.meta.changes) lease.leaseUntil = until;
	return Boolean(result.meta.changes);
}
