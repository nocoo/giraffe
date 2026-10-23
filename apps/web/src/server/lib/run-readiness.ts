import { z } from "zod";
import type { ActivityWindow } from "../../lib/activity-types";
import type { FactoryRun, FactoryRunStep } from "../../lib/factory-run";
import type { FactoryWindow } from "../../lib/factory-types";
import type { Db } from "./db/d1";
import { ApiError } from "./errors";
import {
	decodeRunEstimates,
	estimateRunFinish,
	type RunEstimateRow,
	type RunStepPlan,
	runEstimateStatement,
	runStepPlanSql,
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

type FailedStep = Pick<FactoryRunStep, "kind" | "repo" | "error"> & {
	resource: string | null;
};

type LatestRow = {
	id: string;
	mode: string | null;
	trigger: string | null;
	depth: string | null;
	status: FactoryRun["status"];
	window: string;
	startedAt: string | null;
	nextAttemptAt: string | null;
	stepPlan: string;
	finishedAt: string | null;
	error: string | null;
	publishedAt: string | null;
	publishedAtType: string | null;
	atomicPublicationType: string | null;
	total: number | null;
	success: number | null;
	failed: number | null;
	unavailable: number | null;
	limited: number | null;
	skipped: number | null;
	failedSteps: string;
};

type PublishedAtReason =
	| "legacy_unprovable"
	| "not_published"
	| "in_progress"
	| "failed"
	| "cancelled";

function publishedAtReason(
	status: FactoryRun["status"],
	publishedAt: string | null,
	publishedAtType: string | null,
	atomicPublicationType: string | null,
): PublishedAtReason | null {
	if (status === "completed" || status === "partial") {
		if (publishedAt != null) return null;
		if (publishedAtType != null && atomicPublicationType === "true") return "not_published";
		return "legacy_unprovable";
	}
	if (status === "failed") return "failed";
	if (status === "cancelled") return "cancelled";
	return "in_progress";
}

const latestProjection = `json_extract(payload,'$.id') AS id,
 json_extract(payload,'$.mode') AS mode,
 json_extract(payload,'$.trigger') AS trigger,
 json_extract(payload,'$.depth') AS depth,
 json_extract(payload,'$.status') AS status,
 coalesce(json_extract(payload,'$.activityWindow'),json_extract(payload,'$.window')) AS window,
 json_extract(payload,'$.startedAt') AS startedAt,
 json_extract(payload,'$.nextAttemptAt') AS nextAttemptAt,
 ${runStepPlanSql} AS stepPlan,
 json_extract(payload,'$.finishedAt') AS finishedAt,
 json_extract(payload,'$.error') AS error,
 json_extract(payload,'$.publishedAt') AS publishedAt,
 json_type(payload,'$.publishedAt') AS publishedAtType,
 json_type(payload,'$.atomicPublication') AS atomicPublicationType,
 json_array_length(payload,'$.steps') AS total,
 (SELECT COUNT(*) FROM json_each(payload,'$.steps') WHERE json_extract(value,'$.status')='success') AS success,
 (SELECT COUNT(*) FROM json_each(payload,'$.steps') WHERE json_extract(value,'$.status')='failed') AS failed,
 (SELECT COUNT(*) FROM json_each(payload,'$.steps') WHERE json_extract(value,'$.status')='unavailable') AS unavailable,
 (SELECT COUNT(*) FROM json_each(payload,'$.steps') WHERE json_extract(value,'$.status')='limited') AS limited,
 (SELECT COUNT(*) FROM json_each(payload,'$.steps') WHERE json_extract(value,'$.status')='skipped') AS skipped,
 coalesce((SELECT json_group_array(json_object(
  'kind',json_extract(value,'$.kind'),
  'repo',coalesce(json_extract(value,'$.repo'),json('null')),
  'resource',coalesce(json_extract(value,'$.resource'),json('null')),
  'error',coalesce(json_extract(value,'$.error'),json('null'))
 ) ORDER BY CAST(key AS INTEGER)) FROM json_each(payload,'$.steps') WHERE json_extract(value,'$.status')='failed'),json('[]')) AS failedSteps`;

export async function readLatestRun(db: Db, account: string, query: Record<string, string[]>) {
	const parsed = latestQuery.safeParse(query);
	if (!parsed.success) throw new ApiError(400, "validation_failed", "Invalid run kind");
	const kind = parsed.data.kind[0];
	const [latest, estimates] = await db.batch([
		db
			.prepare(
				`SELECT ${latestProjection} FROM factory_runs WHERE account_id=? AND ${filters[kind]} ORDER BY created_at DESC,id DESC LIMIT 1`,
			)
			.bind(account),
		runEstimateStatement(db, account, false),
	]);
	const row = latest?.results[0] as LatestRow | undefined;
	if (!row) throw new ApiError(404, "not_found", "Run not found");
	const mode = row.mode === "catalog" ? "catalog" : "refresh";
	const depth = mode === "catalog" ? null : row.depth === "quick" ? "quick" : "deep";
	const status = row.status;
	const total = Number(row.total ?? 0);
	const failedSteps = JSON.parse(row.failedSteps) as FailedStep[];
	const publishedAt =
		status === "completed" || status === "partial" ? (row.publishedAt ?? null) : null;
	const calibration = decodeRunEstimates(estimates?.results as RunEstimateRow[]);
	return {
		account_id: account,
		id: row.id,
		kind:
			mode === "catalog"
				? "catalog"
				: row.trigger === "daily" || row.trigger === "weekly"
					? row.trigger
					: "manual",
		depth,
		status,
		window: JSON.parse(row.window) as FactoryWindow | ActivityWindow,
		startedAt: row.startedAt,
		...estimateRunFinish(
			{
				mode,
				depth: depth ?? "deep",
				startedAt: row.startedAt ?? "",
				status,
				...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt } : {}),
				stepPlan: JSON.parse(row.stepPlan) as RunStepPlan,
			},
			total,
			calibration,
		),
		finishedAt: row.finishedAt,
		counts: {
			total,
			success: Number(row.success ?? 0),
			failed: Number(row.failed ?? 0),
			unavailable: Number(row.unavailable ?? 0),
			limited: Number(row.limited ?? 0),
			skipped: Number(row.skipped ?? 0),
		},
		failedSteps,
		lastError: row.error ?? failedSteps.find((step) => step.error)?.error ?? null,
		publishedAt,
		publishedAtReason: publishedAtReason(
			status,
			publishedAt,
			row.publishedAtType,
			row.atomicPublicationType,
		),
	};
}
