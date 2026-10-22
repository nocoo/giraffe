import type { FactoryRun } from "../../lib/factory-run";
import type { Db } from "./db/d1";

export type RunEstimateKind = "catalog" | "quick" | "deep";
export type RunEstimateRow = {
	kind: RunEstimateKind;
	started_at: string;
	finished_at: string;
};
export type RunEstimateCalibration = Record<RunEstimateKind, number | null>;
export type RunFinishEstimate = {
	expectedFinishAt: string | null;
	expectedFinishAtReason: "no_completed_history" | "invalid_started_at" | "not_executed" | null;
};

function validTimestamp(column: "started_at" | "finished_at"): string {
	const zoneLength = `CASE WHEN substr(${column},-1)='Z' THEN 1 WHEN substr(${column},-6) GLOB '[+-][0-2][0-9]:[0-5][0-9]' THEN 6 END`;
	return `typeof(${column})='text' AND ${column} GLOB '????-??-??T??:??:??*'
 AND substr(${column},12,2)<'24' AND (${zoneLength}) IS NOT NULL
 AND (length(${column})=19+(${zoneLength}) OR (
 substr(${column},20,1)='.' AND length(${column})>20+(${zoneLength})
 AND substr(${column},21,length(${column})-20-(${zoneLength})) NOT GLOB '*[^0-9]*'))`;
}

export function runEstimateStatement(db: Db, account: string): D1PreparedStatement {
	return db
		.prepare(`WITH candidates AS (
 SELECT id,
 CASE WHEN json_extract(payload,'$.mode')='catalog' THEN 'catalog'
 WHEN json_extract(payload,'$.depth')='quick' THEN 'quick' ELSE 'deep' END AS kind,
 json_extract(payload,'$.startedAt') AS started_at,
 json_extract(payload,'$.finishedAt') AS finished_at,
 json_array_length(payload,'$.steps') AS total
 FROM factory_runs WHERE account_id=? AND status='completed'
 AND json_extract(payload,'$.mode') IN ('catalog','refresh')
), ranked AS (
 SELECT kind,started_at,finished_at,
 ROW_NUMBER() OVER (PARTITION BY kind ORDER BY julianday(finished_at) DESC,id DESC) AS sample
 FROM candidates WHERE total>0
 AND ${validTimestamp("started_at")} AND ${validTimestamp("finished_at")}
 AND julianday(started_at)<=julianday(finished_at)
)
SELECT kind,started_at,finished_at FROM ranked WHERE sample<=5 ORDER BY kind,sample`)
		.bind(account);
}

export function decodeRunEstimates(rows: readonly RunEstimateRow[]): RunEstimateCalibration {
	const calibration: RunEstimateCalibration = { catalog: null, quick: null, deep: null };
	for (const kind of ["catalog", "quick", "deep"] as const) {
		const durations = rows
			.filter((row) => row.kind === kind)
			.map((row) => Date.parse(row.finished_at) - Date.parse(row.started_at))
			.sort((firstDuration, secondDuration) => firstDuration - secondDuration);
		if (!durations.length) continue;
		const lower = durations[Math.ceil(durations.length / 2) - 1] as number;
		const upper = durations[Math.floor(durations.length / 2)] as number;
		calibration[kind] = (lower + upper) / 2;
	}
	return calibration;
}

export async function readRunEstimates(db: Db, account: string): Promise<RunEstimateCalibration> {
	const result = await runEstimateStatement(db, account).all<RunEstimateRow>();
	return decodeRunEstimates(result.results);
}

export function estimateRunFinish(
	run: Pick<FactoryRun, "mode" | "depth" | "startedAt">,
	total: number,
	calibration: RunEstimateCalibration,
): RunFinishEstimate {
	if (total === 0) return { expectedFinishAt: null, expectedFinishAtReason: "not_executed" };
	const startedAt = Date.parse(run.startedAt);
	if (!Number.isFinite(startedAt))
		return { expectedFinishAt: null, expectedFinishAtReason: "invalid_started_at" };
	const kind = run.mode === "catalog" ? "catalog" : (run.depth ?? "deep");
	const duration = calibration[kind];
	return duration === null
		? { expectedFinishAt: null, expectedFinishAtReason: "no_completed_history" }
		: {
				expectedFinishAt: new Date(startedAt + duration).toISOString(),
				expectedFinishAtReason: null,
			};
}
