import type { Context } from "hono";
import { z } from "zod";
import { type FactoryRunResponse, runProgress } from "../../lib/factory-run";
import type { AppVars, Env } from "../env";
import { getActiveAccount } from "../lib/db/accounts";
import { controlRun, getRun } from "../lib/db/factory-runs";
import { ApiError, jsonOk } from "../lib/errors";
import { enqueueRun, handoffAccount } from "../lib/factory-dispatch";
import { readFactoryRunInputs } from "../lib/factory-run-read";
import { refreshInput, startRefresh } from "../lib/factory-start";
import { ACCOUNT_ID_RE } from "../lib/id";
import { readJson } from "../lib/read-body";
import { estimateRunFinish } from "../lib/run-estimates";

type Ctx = Context<{ Bindings: Env; Variables: AppVars }>;
const PRIVATE = { "cache-control": "private, no-store" };
async function account(c: Ctx) {
	const row = await getActiveAccount(c.get("db"));
	if (!row) throw new ApiError(409, "account_missing", "no active account");
	return row;
}
export async function getFactoryRuns(c: Ctx): Promise<Response> {
	const row = await account(c);
	const db = c.get("db");
	const detail = c.req.query("history") ?? "";
	if (detail.length > 80) throw new ApiError(400, "validation_failed", "invalid history ID");
	const { runs, calibration, head, catalog, policy, siteRepos, states, storage } =
		await readFactoryRunInputs(db, row.id, detail);
	const now = new Date().toISOString();
	const views = runs.map(({ run, leaseUntil, counts }) => {
		const { checkpoint, ...view } = run;
		void checkpoint;
		return {
			...view,
			...estimateRunFinish(run, counts.total, calibration),
			progress: {
				...runProgress(run, now),
				...counts,
				completed:
					counts.success + counts.failed + counts.skipped + counts.unavailable + counts.limited,
			},
			leaseUntil,
		};
	});
	const response: FactoryRunResponse = {
		storage,
		account_id: row.id,
		serverNow: now,
		nextAllowedAt: head?.next_at ?? null,
		current: views.find((r) => r.status === "running" || r.status === "paused") ?? null,
		history: views.filter((r) => r.status !== "running" && r.status !== "paused").slice(0, 20),
		repositories: states.filter((state) => policy.includes(state.repo)),
		catalog: catalog?.repos ?? [],
		catalogUpdatedAt: catalog?.fetched_at ?? null,
		catalogComplete: Boolean(
			catalog?.inventory.complete &&
				siteRepos?.every((name) => catalog.repos.some((repo) => repo.name === name)),
		),
		publication: head?.published_id ?? null,
	};
	return jsonOk(response, 200, PRIVATE, c.get("sourceTiming"));
}
export async function postFactoryRun(c: Ctx): Promise<Response> {
	const parsed = refreshInput.safeParse(await readJson(c.req.raw, 120_000));
	if (!parsed.success) throw new ApiError(400, "validation_failed", "invalid refresh plan");
	const data = parsed.data;
	const row = await account(c);
	if (data.account_id !== row.id) throw new ApiError(409, "account_conflict", "account changed");
	const db = c.get("db");
	const now = new Date().toISOString();
	const run = await startRefresh(db, row, data, now);
	// A queue outage cannot erase a committed run: the scheduled D1 scan retries dispatch.
	try {
		await enqueueRun(c.env, run.id, run.nextAttemptAt);
	} catch {
		/* durable cron continuation */
	}
	return jsonOk(
		{ account_id: row.id, id: run.id, status: run.status, totalSteps: run.steps.length },
		202,
		PRIVATE,
	);
}
export async function postFactoryControl(c: Ctx): Promise<Response> {
	const parsed = z
		.object({
			account_id: z.string().regex(ACCOUNT_ID_RE),
			action: z.enum(["pause", "resume", "cancel"]),
		})
		.safeParse(await readJson(c.req.raw, 120_000));
	if (!parsed.success) throw new ApiError(400, "validation_failed", "invalid run control");
	const row = await account(c);
	if (parsed.data.account_id !== row.id)
		throw new ApiError(409, "account_conflict", "account changed");
	const id = c.req.param("id") ?? "";
	if (!(await getRun(c.get("db"), row.id, id)))
		throw new ApiError(404, "not_found", "run not found");
	const run = await controlRun(
		c.get("db"),
		row.id,
		id,
		parsed.data.action,
		new Date().toISOString(),
	);
	if (run.status === "running")
		try {
			await enqueueRun(c.env, run.id, run.nextAttemptAt);
		} catch {
			/* durable cron continuation */
		}
	else if (run.status !== "paused") {
		try {
			await handoffAccount(c.env, row.id);
		} catch {
			/* durable cron continuation */
		}
	}
	return jsonOk({ account_id: row.id, id: run.id, status: run.status }, 200, PRIVATE);
}
