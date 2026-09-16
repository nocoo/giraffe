import type { Context } from "hono";
import { z } from "zod";
import {
	type FactoryRunResponse,
	makeRun,
	runProgress,
	selectRunRepos,
} from "../../lib/factory-run";
import type { AppVars, Env } from "../env";
import { getActiveAccount } from "../lib/db/accounts";
import {
	catalogFactory,
	controlRun,
	factoryHead,
	getRun,
	listRuns,
	repoStates,
	startRun,
} from "../lib/db/factory-runs";
import { ApiError, jsonOk } from "../lib/errors";
import { enqueueRun } from "../lib/factory-dispatch";
import { boundedJson } from "../lib/factory-publish";
import { ACCOUNT_ID_RE } from "../lib/id";
import { readJson } from "../lib/read-body";

type Ctx = Context<{ Bindings: Env; Variables: AppVars }>;
const PRIVATE = { "cache-control": "private, no-store" };
const input = z.object({
	account_id: z.string().regex(ACCOUNT_ID_RE),
	requestKey: z.string().uuid(),
	mode: z.enum(["catalog", "refresh"]),
	scope: z.enum(["all", "selected", "filter", "stale", "failed"]).default("selected"),
	repos: z.array(z.string().max(200)).max(500).optional(),
	language: z.string().max(100).optional(),
	topic: z.string().max(100).optional(),
	query: z.string().max(100).optional(),
});
async function account(c: Ctx) {
	const row = await getActiveAccount(c.get("db"));
	if (!row) throw new ApiError(409, "account_missing", "no active account");
	return row;
}
export async function getFactoryRuns(c: Ctx): Promise<Response> {
	const row = await account(c);
	const db = c.get("db");
	const runs = await listRuns(db, row.id);
	const head = await factoryHead(db, row.id);
	const catalog = await catalogFactory(db, row.id);
	const states = await repoStates(db, row.id);
	const now = new Date().toISOString();
	const views = runs.map(({ run, leaseUntil }) => {
		const { checkpoint, ...view } = run;
		void checkpoint;
		return { ...view, progress: runProgress(run, now), leaseUntil };
	});
	const response: FactoryRunResponse = {
		account_id: row.id,
		serverNow: now,
		nextAllowedAt: head?.next_at ?? null,
		current: views.find((r) => r.status === "running" || r.status === "paused") ?? null,
		history: views.filter((r) => r.status !== "running" && r.status !== "paused").slice(0, 20),
		repositories: states,
		catalog: catalog?.repos ?? [],
		catalogUpdatedAt: catalog?.fetched_at ?? null,
		catalogComplete: catalog?.inventory.complete ?? false,
		publication: head?.published_id ?? null,
	};
	return jsonOk(response, 200, PRIVATE);
}
export async function postFactoryRun(c: Ctx): Promise<Response> {
	const parsed = input.safeParse(await readJson(c.req.raw, 120_000));
	if (!parsed.success) throw new ApiError(400, "validation_failed", "invalid refresh plan");
	const data = parsed.data;
	const row = await account(c);
	if (data.account_id !== row.id) throw new ApiError(409, "account_conflict", "account changed");
	const db = c.get("db");
	const now = new Date().toISOString();
	const catalog = await catalogFactory(db, row.id);
	const states = await repoStates(db, row.id);
	if (
		data.mode === "refresh" &&
		(!catalog || (data.scope !== "selected" && !catalog.inventory.complete))
	)
		throw new ApiError(409, "catalog_incomplete", "discover complete catalog first");
	let repos: NonNullable<Awaited<ReturnType<typeof catalogFactory>>>["repos"];
	try {
		repos =
			data.mode === "catalog"
				? []
				: selectRunRepos(
						catalog?.repos ?? [],
						states,
						{
							scope: data.scope,
							repos: data.repos ?? [],
							language: data.language ?? "",
							topic: data.topic ?? "",
							query: data.query ?? "",
						},
						now,
					);
	} catch {
		throw new ApiError(400, "validation_failed", "invalid repository selection");
	}
	if (data.scope !== "selected" && data.repos?.length) {
		const order = new Map(data.repos.map((name, i) => [name, i]));
		repos.sort((a, b) => (order.get(a.name) ?? 1000) - (order.get(b.name) ?? 1000));
	}
	if (data.mode === "refresh" && (!repos.length || repos.length > 500))
		throw new ApiError(400, "validation_failed", "select 1 to 500 repositories");
	if (
		data.mode === "refresh" &&
		repos.every((r) => states.some((s) => s.repo === r.name && s.nextAllowedAt > now))
	)
		throw new ApiError(409, "refresh_cooldown", "all selected repositories are cooling down");
	const plan = makeRun(
		crypto.randomUUID(),
		row.id,
		row.login,
		data.requestKey,
		data.mode,
		repos,
		now,
		states,
	);
	boundedJson(plan);
	const run = await startRun(db, plan);
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
	return jsonOk({ account_id: row.id, id: run.id, status: run.status }, 200, PRIVATE);
}
