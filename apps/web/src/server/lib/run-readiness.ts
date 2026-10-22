import { z } from "zod";
import { type FactoryRun, runProgress } from "../../lib/factory-run";
import type { Db } from "./db/d1";
import { ApiError } from "./errors";
import {
	decodeRunEstimates,
	estimateRunFinish,
	type RunEstimateRow,
	runEstimateStatement,
} from "./run-estimates";

const latestQuery = z.strictObject({
	kind: z.tuple([z.enum(["daily", "weekly", "catalog", "manual", "quick", "deep"])]),
});

const filters = {
	daily: "json_extract(payload,'$.mode')='refresh' AND json_extract(payload,'$.trigger')='daily'",
	weekly: "json_extract(payload,'$.mode')='refresh' AND json_extract(payload,'$.trigger')='weekly'",
	catalog: "json_extract(payload,'$.mode')='catalog'",
	manual:
		"json_extract(payload,'$.mode')='refresh' AND coalesce(json_extract(payload,'$.trigger'),'manual')='manual'",
	quick: "json_extract(payload,'$.mode')='refresh' AND json_extract(payload,'$.depth')='quick'",
	deep: "json_extract(payload,'$.mode')='refresh' AND coalesce(json_extract(payload,'$.depth'),'deep')='deep'",
};

export async function readLatestRun(db: Db, account: string, query: Record<string, string[]>) {
	const parsed = latestQuery.safeParse(query);
	if (!parsed.success) throw new ApiError(400, "validation_failed", "Invalid run kind");
	const kind = parsed.data.kind[0];
	const [latest, estimates] = await db.batch([
		db
			.prepare(
				`SELECT json_remove(payload,'$.checkpoint') AS payload FROM factory_runs WHERE account_id=? AND ${filters[kind]} ORDER BY created_at DESC,id DESC LIMIT 1`,
			)
			.bind(account),
		runEstimateStatement(db, account),
	]);
	const row = latest?.results[0] as { payload: string } | undefined;
	if (!row) throw new ApiError(404, "not_found", "Run not found");
	const run = JSON.parse(row.payload) as FactoryRun;
	const calibration = decodeRunEstimates(estimates?.results as RunEstimateRow[]);
	const { total, success, failed, unavailable, limited, skipped } = runProgress(run, run.updatedAt);
	const failedSteps = run.steps
		.filter((step) => step.status === "failed")
		.map((step) => ({
			kind: step.kind,
			repo: step.repo,
			resource: step.resource ?? null,
			error: step.error,
		}));
	return {
		account_id: account,
		id: run.id,
		kind: run.mode === "catalog" ? "catalog" : (run.trigger ?? "manual"),
		status: run.status,
		window: run.activityWindow ?? run.window,
		startedAt: run.startedAt,
		...estimateRunFinish(run, total, calibration),
		finishedAt: run.finishedAt,
		counts: { total, success, failed, unavailable, limited, skipped },
		failedSteps,
		lastError: run.error ?? failedSteps.find((step) => step.error)?.error ?? null,
		publishedAt:
			run.status === "completed" || run.status === "partial" ? (run.publishedAt ?? null) : null,
	};
}
