import type { FactoryRun } from "../../lib/factory-run";

export const RUN_WALL_TIMEOUT_MS = {
	catalog: 30 * 60_000,
	quick: 6 * 3600_000,
	deep: 12 * 3600_000,
} as const;

export const RUN_DEADLINE_SQL = `MIN(COALESCE(json_extract(payload,'$.deadlineAt'),'9999-12-31T23:59:59.999Z'),strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(payload,'$.startedAt'),CASE WHEN json_extract(payload,'$.mode')='catalog' THEN '+30 minutes' WHEN json_extract(payload,'$.depth')='quick' THEN '+6 hours' ELSE '+12 hours' END))`;

export function runDeadlineAt(run: FactoryRun): string {
	const limit = RUN_WALL_TIMEOUT_MS[run.mode === "catalog" ? "catalog" : (run.depth ?? "deep")];
	const deadline = new Date(Date.parse(run.startedAt) + limit).toISOString();
	return run.deadlineAt && run.deadlineAt < deadline ? run.deadlineAt : deadline;
}

export function timedOutRun(run: FactoryRun, now: string): FactoryRun | null {
	if (!["running", "paused"].includes(run.status) || runDeadlineAt(run) > now) return null;
	const expired = structuredClone(run);
	expired.deadlineAt = runDeadlineAt(run);
	expired.status = "failed";
	expired.error = "run_timed_out";
	expired.updatedAt = now;
	expired.finishedAt = now;
	for (const step of expired.steps)
		if (step.status === "pending" || step.status === "running") {
			step.status = step.status === "running" ? "failed" : "skipped";
			step.error = "run_timed_out";
			step.finishedAt = now;
		}
	return expired;
}
