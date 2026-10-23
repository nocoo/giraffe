import {
	type FactoryRun,
	type FactoryRunStep,
	factoryRunDuration,
	type RunFinishEstimateReason,
	type StepKind,
} from "../../lib/factory-run";
import type { Db } from "./db/d1";

export type RunEstimateKind = "catalog" | "quick" | "deep";
export type RunEstimateRow = {
	kind: RunEstimateKind;
	started_at: string;
	finished_at: string;
	total: number;
	work_total: number;
	timed_total: number;
	timed_steps: string;
	step_medians: string | null;
	plans: string | null;
};
export type RunStepPlan = [kind: StepKind, total: number, remaining: number, repo: string | null][];
export type RunEstimateCalibration = Record<RunEstimateKind, number | null> & {
	stepKinds?: Partial<Record<RunEstimateKind, Partial<Record<StepKind, number>>>>;
	overhead?: Partial<Record<RunEstimateKind, number>>;
	plans?: Record<string, RunStepPlan>;
};
export type RunFinishEstimate = {
	expectedFinishAt: string | null;
	expectedFinishAtReason: RunFinishEstimateReason;
};

function validTimestamp(column: "started_at" | "finished_at"): string {
	const zoneLength = `CASE WHEN substr(${column},-1)='Z' THEN 1 WHEN substr(${column},-6) GLOB '[+-][0-2][0-9]:[0-5][0-9]' THEN 6 END`;
	return `typeof(${column})='text' AND ${column} GLOB '????-??-??T??:??:??*'
 AND substr(${column},12,2)<'24' AND (${zoneLength}) IS NOT NULL
 AND (length(${column})=19+(${zoneLength}) OR (
 substr(${column},20,1)='.' AND length(${column})>20+(${zoneLength})
 AND substr(${column},21,length(${column})-20-(${zoneLength})) NOT GLOB '*[^0-9]*'))`;
}

export const runStepPlanSql = `(SELECT json_group_array(json_array(step_kind,total,remaining,repo)) FROM (
 SELECT json_extract(value,'$.kind') AS step_kind,
 json_extract(value,'$.repo') AS repo,
 SUM(json_extract(value,'$.status')!='skipped') AS total,
 SUM(json_extract(value,'$.status') IN ('pending','running')) AS remaining
 FROM json_each(payload,'$.steps') GROUP BY json_extract(value,'$.kind'),json_extract(value,'$.repo')
 ORDER BY MIN(CAST(key AS INTEGER))))`;

export function runEstimateStatement(
	db: Db,
	account: string,
	includePlans = true,
): D1PreparedStatement {
	const plans = includePlans
		? `(SELECT json_group_object(id,json(plan)) FROM (
 SELECT id,${runStepPlanSql} AS plan FROM (
 SELECT id,payload FROM factory_runs WHERE account_id=?
 ORDER BY CASE WHEN status IN ('running','paused') THEN 0 ELSE 1 END,created_at DESC LIMIT 21)))`
		: "NULL";
	return db
		.prepare(`WITH candidates AS (
 SELECT id,
 CASE WHEN json_extract(payload,'$.mode')='catalog' THEN 'catalog'
 WHEN json_extract(payload,'$.depth')='quick' THEN 'quick' ELSE 'deep' END AS kind,
 json_extract(payload,'$.startedAt') AS started_at,
 json_extract(payload,'$.finishedAt') AS finished_at,
 json_array_length(payload,'$.steps') AS total,
 (SELECT COUNT(*) FROM json_each(payload,'$.steps') WHERE json_extract(value,'$.status')!='skipped') AS work_total
 FROM factory_runs WHERE account_id=? AND status IN ('completed','partial')
 AND json_extract(payload,'$.mode') IN ('catalog','refresh')
), ranked AS (
 SELECT id,kind,started_at,finished_at,total,work_total,
 ROW_NUMBER() OVER (PARTITION BY kind ORDER BY julianday(finished_at) DESC,id DESC) AS sample
 FROM candidates WHERE total>0 AND work_total>0
 AND ${validTimestamp("started_at")} AND ${validTimestamp("finished_at")}
 AND julianday(started_at)<=julianday(finished_at)
), samples AS MATERIALIZED (
 SELECT * FROM ranked WHERE sample<=5
), step_values AS MATERIALIZED (
 SELECT samples.id,samples.kind,CAST(step.key AS INTEGER) AS step_index,
 json_extract(step.value,'$.kind') AS step_kind,json_extract(step.value,'$.repo') AS repo,
 json_extract(step.value,'$.durationMs') AS duration_ms
 FROM samples JOIN factory_runs runs ON runs.id=samples.id,json_each(runs.payload,'$.steps') step
 WHERE json_extract(step.value,'$.status') IN ('success','failed','unavailable','limited')
 AND json_extract(step.value,'$.attempts')>0
 AND json_type(step.value,'$.durationMs') IN ('integer','real')
 AND json_extract(step.value,'$.durationMs')>=0
), step_ranked AS (
 SELECT *,ROW_NUMBER() OVER (PARTITION BY kind,step_kind ORDER BY duration_ms) AS position,
 COUNT(*) OVER (PARTITION BY kind,step_kind) AS size FROM (
 SELECT kind,step_kind,duration_ms FROM step_values
 UNION ALL SELECT kind,'*',duration_ms FROM step_values
 )
), step_medians AS (
 SELECT kind,step_kind,AVG(duration_ms) AS duration_ms FROM step_ranked
 WHERE position IN ((size+1)/2,(size+2)/2) GROUP BY kind,step_kind
)
SELECT kind,started_at,finished_at,total,work_total,
 (SELECT COUNT(*) FROM step_values WHERE step_values.id=samples.id) AS timed_total,
 (SELECT json_group_array(json_array(step_kind,repo,duration_ms)) FROM (
 SELECT step_kind,repo,duration_ms FROM step_values WHERE step_values.id=samples.id ORDER BY step_index)) AS timed_steps,
 CASE WHEN sample=1 THEN (SELECT json_group_object(step_kind,duration_ms) FROM step_medians WHERE step_medians.kind=samples.kind) END AS step_medians,
 CASE WHEN ROW_NUMBER() OVER (ORDER BY kind,sample)=1 THEN ${plans} END AS plans
 FROM samples ORDER BY kind,sample`)
		.bind(account, ...(includePlans ? [account] : []));
}

function median(values: number[]): number | null {
	if (!values.length) return null;
	values.sort((first, second) => first - second);
	return (
		((values[Math.ceil(values.length / 2) - 1] as number) +
			(values[Math.floor(values.length / 2)] as number)) /
		2
	);
}

export function decodeRunEstimates(rows: readonly RunEstimateRow[]): RunEstimateCalibration {
	const calibration: RunEstimateCalibration = { catalog: null, quick: null, deep: null };
	for (const kind of ["catalog", "quick", "deep"] as const) {
		const samples = rows.filter((row) => row.kind === kind);
		const wallDuration = (row: RunEstimateRow) =>
			Date.parse(row.finished_at) - Date.parse(row.started_at);
		const encoded = samples.find((row) => row.step_medians)?.step_medians;
		const { "*": overall, ...stepKinds } = encoded
			? (JSON.parse(encoded) as Partial<Record<StepKind | "*", number>>)
			: {};
		calibration[kind] = overall ?? median(samples.map((row) => wallDuration(row) / row.work_total));
		if (overall !== undefined) {
			calibration.stepKinds ??= {};
			calibration.stepKinds[kind] = stepKinds;
			const overhead = median(
				samples
					.filter((row) => row.timed_total === row.work_total)
					.map((row) => {
						const steps = JSON.parse(row.timed_steps) as [StepKind, string | null, number][];
						const measured = steps.map(([kind, repo, durationMs]) => ({ kind, repo, durationMs }));
						const duration = factoryRunDuration(measured);
						// Invocation-boundary delays remain serial overhead, not fixed repository batches.
						return Math.max(0, wallDuration(row) - duration) / row.work_total;
					}),
			);
			if (overhead !== null) {
				calibration.overhead ??= {};
				calibration.overhead[kind] = overhead;
			}
		}
	}
	const plans = rows.find((row) => row.plans)?.plans;
	if (plans) calibration.plans = JSON.parse(plans) as Record<string, RunStepPlan>;
	return calibration;
}

export async function readRunEstimates(db: Db, account: string): Promise<RunEstimateCalibration> {
	const result = await runEstimateStatement(db, account).all<RunEstimateRow>();
	return decodeRunEstimates(result.results);
}

export function estimateRunFinish(
	run: Pick<FactoryRun, "mode" | "depth" | "startedAt"> &
		Partial<Pick<FactoryRun, "id" | "status" | "cursor" | "nextAttemptAt">> & {
			steps?: readonly (Pick<FactoryRunStep, "kind" | "status"> &
				Partial<Pick<FactoryRunStep, "repo">>)[];
			completed?: number;
			stepPlan?: RunStepPlan;
		},
	total: number,
	calibration: RunEstimateCalibration,
	now = new Date().toISOString(),
): RunFinishEstimate {
	if (run.status && ["completed", "failed", "partial", "cancelled"].includes(run.status))
		return { expectedFinishAt: null, expectedFinishAtReason: "terminal" };
	if (total === 0) return { expectedFinishAt: null, expectedFinishAtReason: "not_executed" };
	const startedAt = Date.parse(run.startedAt);
	if (!Number.isFinite(startedAt))
		return { expectedFinishAt: null, expectedFinishAtReason: "invalid_started_at" };
	const kind = run.mode === "catalog" ? "catalog" : (run.depth ?? "deep");
	const perStep = calibration[kind];
	if (perStep === null)
		return { expectedFinishAt: null, expectedFinishAtReason: "no_completed_history" };
	const active = run.status === "running" || run.status === "paused";
	const medians = calibration.stepKinds?.[kind];
	const overhead = calibration.overhead?.[kind] ?? 0;
	const stepDuration = (stepKind: StepKind) => medians?.[stepKind] ?? perStep;
	const plan = run.stepPlan ?? (run.id ? calibration.plans?.[run.id] : undefined);
	const plannedDuration = (
		steps: { kind: StepKind; repo?: string | null; durationMs: number; count: number }[],
	) =>
		(medians ? factoryRunDuration(steps) : steps.reduce((sum, step) => sum + step.durationMs, 0)) +
		steps.reduce((sum, step) => sum + overhead * step.count, 0);
	let duration: number;
	if (run.steps?.length === total) {
		duration = plannedDuration(
			run.steps
				.filter(
					(step) =>
						step.status !== "skipped" && (!active || ["pending", "running"].includes(step.status)),
				)
				.map((step) => ({ ...step, durationMs: stepDuration(step.kind), count: 1 })),
		);
	} else if (plan) {
		duration = plannedDuration(
			plan.flatMap(([kind, total, remaining, repo]) => {
				const count = active ? remaining : total;
				return count ? [{ kind, repo, durationMs: stepDuration(kind) * count, count }] : [];
			}),
		);
	} else {
		const remaining = active ? Math.max(0, total - (run.completed ?? run.cursor ?? 0)) : total;
		duration = (perStep + overhead) * remaining;
	}
	const anchor = active
		? Math.max(startedAt, Date.parse(now), Date.parse(run.nextAttemptAt ?? "") || 0)
		: startedAt;
	return {
		expectedFinishAt: new Date(anchor + Math.ceil(duration)).toISOString(),
		expectedFinishAtReason: null,
	};
}
