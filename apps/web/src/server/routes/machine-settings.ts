import type { Context } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { getAccount } from "../lib/db/accounts";
import { controlRun, getRun, listRuns } from "../lib/db/factory-runs";
import { ApiError } from "../lib/errors";
import { enqueueRun } from "../lib/factory-dispatch";
import { refreshInput, startRefresh } from "../lib/factory-start";
import { requireCatalogRepo } from "../lib/machine-observations";
import { readJson } from "../lib/read-body";
import { readSchedules, saveSchedule, starredRepos } from "../lib/refresh-schedule";
import type { MachineVars } from "./machine";

type Ctx = Context<{ Bindings: Env; Variables: MachineVars }>;
export async function getMachineSettings(c: Ctx) {
	const account = c.get("principal").accountId;
	const db = c.get("db");
	const stats = await db
		.prepare("SELECT repo,enabled FROM repo_statistics WHERE account_id=? ORDER BY repo")
		.bind(account)
		.all<{ repo: string; enabled: number }>();
	return c.json({
		account_id: account,
		stars: await starredRepos(db, account),
		statistics: stats.results.map((r) => ({ ...r, enabled: r.enabled === 1 })),
		schedules: await readSchedules(db, account),
	});
}
export async function machineSetting(c: Ctx) {
	const method = c.req.method;
	if (!["PUT", "DELETE"].includes(method))
		throw new ApiError(405, "method_not_allowed", "method not allowed");
	const account = c.get("principal").accountId;
	const db = c.get("db");
	const now = new Date().toISOString();
	if (c.req.param("kind")) {
		const kind = z.enum(["daily", "weekly", "catalog"]).safeParse(c.req.param("kind"));
		if (!kind.success) throw new ApiError(400, "validation_failed", "invalid schedule");
		if (method === "DELETE")
			await db
				.prepare(
					`DELETE FROM ${kind.data === "catalog" ? "catalog_refresh_schedules" : "refresh_schedules"} WHERE account_id=? AND kind=?`,
				)
				.bind(account, kind.data)
				.run();
		else {
			const parsed = z
				.object({
					enabled: z.boolean(),
					time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
					weekday: z.number().int().min(0).max(6),
					scope: z.enum(["all", "starred"]),
				})
				.strict()
				.safeParse(await readJson(c.req.raw, 2048));
			if (
				!parsed.success ||
				(kind.data === "daily" && parsed.data.scope !== "starred") ||
				(kind.data === "catalog" && (parsed.data.scope !== "all" || parsed.data.weekday !== 0))
			)
				throw new ApiError(400, "validation_failed", "invalid schedule");
			await saveSchedule(db, account, kind.data, parsed.data, now);
		}
	} else {
		const repo = await requireCatalogRepo(
			db,
			account,
			`${c.req.param("owner")}/${c.req.param("name")}`,
		);
		const star = c.req.path.includes("/stars/");
		const table = star ? "repo_stars" : "repo_statistics";
		if (method === "DELETE")
			await db
				.prepare(`DELETE FROM ${table} WHERE account_id=? AND repo=?`)
				.bind(account, repo)
				.run();
		else if (star)
			await db
				.prepare(
					"INSERT INTO repo_stars(account_id,repo) VALUES(?,?) ON CONFLICT(account_id,repo) DO NOTHING",
				)
				.bind(account, repo)
				.run();
		else {
			const parsed = z
				.object({ enabled: z.boolean() })
				.strict()
				.safeParse(await readJson(c.req.raw, 2048));
			if (!parsed.success) throw new ApiError(400, "validation_failed", "invalid statistics");
			await db
				.prepare(
					"INSERT INTO repo_statistics(account_id,repo,enabled) VALUES(?,?,?) ON CONFLICT(account_id,repo) DO UPDATE SET enabled=excluded.enabled",
				)
				.bind(account, repo, Number(parsed.data.enabled))
				.run();
		}
	}
	return method === "DELETE" ? c.body(null, 204) : getMachineSettings(c);
}
export async function machineRuns(c: Ctx) {
	const accountId = c.get("principal").accountId;
	const db = c.get("db");
	const account = await getAccount(db, accountId);
	if (!account) throw new ApiError(404, "not_found", "account unavailable");
	const id = c.req.param("id");
	if (c.req.method === "GET" && !id)
		return c.json({
			account_id: accountId,
			items: (await listRuns(db, accountId)).map(({ run }) => {
				const { checkpoint, ...data } = run;
				void checkpoint;
				return data;
			}),
		});
	if (c.req.method !== "POST") throw new ApiError(405, "method_not_allowed", "method not allowed");
	const body = await readJson(c.req.raw, 120000);
	const now = new Date().toISOString();
	let run: Awaited<ReturnType<typeof startRefresh>>;
	if (id) {
		const parsed = z
			.object({ action: z.enum(["pause", "resume", "cancel"]) })
			.strict()
			.safeParse(body);
		if (!parsed.success) throw new ApiError(400, "validation_failed", "invalid action");
		if (!(await getRun(db, accountId, id))) throw new ApiError(404, "not_found", "run missing");
		run = await controlRun(db, accountId, id, parsed.data.action, now);
	} else {
		const parsed = refreshInput.omit({ account_id: true }).strict().safeParse(body);
		if (!parsed.success) throw new ApiError(400, "validation_failed", "invalid refresh plan");
		run = await startRefresh(db, account, { ...parsed.data, account_id: accountId }, now);
	}
	if (run.status === "running")
		try {
			await enqueueRun(c.env, run.id, run.nextAttemptAt);
		} catch {
			/* Durable cron resumes a queued run. */
		}
	return c.json({ account_id: accountId, id: run.id, status: run.status }, 202);
}
