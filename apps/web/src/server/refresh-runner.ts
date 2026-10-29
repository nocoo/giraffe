import { z } from "zod";
import type { RefreshRun } from "../lib/refresh-types";
import { type Env, encryptionKey } from "./env";
import { getAccount } from "./lib/db/accounts";
import { createDb } from "./lib/db/d1";
import { ApiError, jsonError } from "./lib/errors";
import { collectAccount, collectRepository } from "./lib/refresh-collection";
import { parseRefreshParams, refreshDays } from "./lib/refresh-params";
import {
	activeRefreshRun,
	createRefreshRun,
	saveRefreshRun,
	scheduledRefreshRun,
} from "./lib/refresh-store";
import { decryptToken, parseKeyBytes } from "./lib/token-crypto";

const startSchema = z
	.object({
		accountId: z.string().min(1).max(100),
		params: z.unknown(),
		trigger: z.enum(["manual", "scheduled"]),
		at: z.iso.datetime(),
	})
	.strict();
const safeCodes = new Set([
	"github_rate_limited",
	"github_error",
	"github_unauthorized",
	"github_unavailable",
	"encryption_misconfigured",
	"db_error",
	"account_missing",
	"not_found",
	"validation_failed",
]);
const failureCode = (error: unknown) =>
	error instanceof ApiError && safeCodes.has(error.code) ? error.code : "refresh_failed";
const terminal = (run: RefreshRun) => !["queued", "running"].includes(run.status);
function finish(run: RefreshRun): RefreshRun {
	return {
		...run,
		phase: "done",
		status: run.partial ? "partial" : "completed",
		errorCode: run.partial ? run.errorCode : null,
		finishedAt: run.updatedAt,
	};
}

export async function startRefresh(
	env: Env,
	accountId: string,
	input: unknown,
	trigger: RefreshRun["trigger"] = "manual",
	at = new Date(),
): Promise<RefreshRun> {
	const params = parseRefreshParams(input, at);
	if (!env.REFRESH_RUNNER)
		throw new ApiError(503, "refresh_unavailable", "refresh runner binding unavailable");
	const response = await env.REFRESH_RUNNER.getByName(accountId).fetch(
		new Request("https://refresh.internal/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ accountId, params, trigger, at: at.toISOString() }),
		}),
	);
	if (!response.ok) {
		const body = (await response.json()) as { error: { code: string } };
		throw new ApiError(response.status, body.error.code, "refresh could not start");
	}
	return response.json() as Promise<RefreshRun>;
}

export class RefreshRunner implements DurableObject {
	constructor(
		private readonly state: DurableObjectState,
		private readonly env: Env,
	) {}
	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST")
			return jsonError(405, "method_not_allowed", "method not allowed");
		try {
			const body = startSchema.safeParse(await request.json());
			if (!body.success) throw new ApiError(400, "validation_failed", "invalid refresh request");
			const { accountId, trigger, at } = body.data;
			const params = parseRefreshParams(body.data.params, new Date(at));
			return await this.state.blockConcurrencyWhile(async () => {
				const db = createDb(this.env.DB);
				if (!(await getAccount(db, accountId)))
					throw new ApiError(404, "account_missing", "account missing");
				const existingAccount = await this.state.storage.get<string>("accountId");
				if (existingAccount && existingAccount !== accountId)
					throw new ApiError(400, "validation_failed", "account mismatch");
				await this.state.storage.put("accountId", accountId);
				const day = new Date(Date.parse(at) + 8 * 3_600_000).toISOString().slice(0, 10);
				const scheduled =
					trigger === "scheduled" ? await scheduledRefreshRun(db, accountId, day) : null;
				if (scheduled) return Response.json(scheduled, { status: 202 });
				const active = await activeRefreshRun(db, accountId);
				if (active && trigger === "manual") {
					if (JSON.stringify(active.params) !== JSON.stringify(params))
						return jsonError(409, "refresh_conflict", "a different refresh is already active");
					return Response.json(active, { status: 202 });
				}
				if (!active) await this.state.storage.setAlarm(Date.now() + 1_000);
				const run = await createRefreshRun(
					db,
					accountId,
					params,
					trigger,
					at,
					trigger === "scheduled" ? day : null,
				);
				return Response.json(run, { status: 202 });
			});
		} catch (error) {
			return jsonError(
				error instanceof ApiError ? error.status : 500,
				failureCode(error),
				"refresh could not start",
			);
		}
	}
	async alarm(): Promise<void> {
		const db = createDb(this.env.DB);
		const saved = await this.state.blockConcurrencyWhile(async () => {
			const accountId = await this.state.storage.get<string>("accountId");
			const active = accountId ? await activeRefreshRun(db, accountId) : null;
			if (!active) {
				await this.state.storage.deleteAlarm();
				return null;
			}
			await this.state.storage.setAlarm(Date.now() + 5 * 60_000);
			return active;
		});
		if (!saved) return;
		const accountId = saved.accountId;
		let run: RefreshRun = { ...saved, status: "running", updatedAt: new Date().toISOString() };
		let requests = 0;
		await saveRefreshRun(db, run);
		try {
			const account = await getAccount(db, accountId);
			if (!account) throw new ApiError(404, "account_missing", "account missing");
			const key = encryptionKey(this.env, account.key_version);
			if (!key) throw new ApiError(500, "encryption_misconfigured", "encryption unavailable");
			const token = await decryptToken(account.token_ciphertext, parseKeyBytes(key));
			const context = {
				onRequests: (count: number) => {
					requests = count;
				},
				env: this.env,
				account,
				token,
				run,
				days: refreshDays(run.params),
				now: run.updatedAt,
			};
			if (run.phase === "account") {
				const result = await collectAccount(context);
				run = {
					...run,
					phase: "repos",
					repos: result.repos,
					requests: run.requests + result.requests,
					partial: run.partial || result.partial,
				};
			} else {
				const repo = run.repos[run.completedRepos];
				if (!repo) throw new ApiError(500, "validation_failed", "repository cursor invalid");
				const result = await collectRepository(context, repo);
				run = {
					...run,
					completedRepos: run.completedRepos + 1,
					requests: run.requests + result.requests,
					partial: run.partial || result.partial,
				};
			}
			await this.state.storage.delete("retry");
			if (run.completedRepos >= run.repos.length) run = finish(run);
		} catch (error) {
			const code = failureCode(error);
			const retryKey = `${run.id}:${run.phase}:${run.completedRepos}`;
			const retry = await this.state.storage.get<{ key: string; attempts: number }>("retry");
			const attempts = retry?.key === retryKey ? retry.attempts : 0;
			const fatal = [
				"github_unauthorized",
				"encryption_misconfigured",
				"account_missing",
				"not_found",
				"validation_failed",
			].includes(code);
			run = { ...run, errorCode: code, requests: saved.requests + requests };
			if (!fatal && attempts < 3) {
				await this.state.storage.put("retry", { key: retryKey, attempts: attempts + 1 });
				await saveRefreshRun(db, run);
				const retryAt = error instanceof ApiError && error.retryAt ? Date.parse(error.retryAt) : 0;
				await this.state.storage.setAlarm(
					Math.max(Date.now() + 60_000 * 2 ** attempts, Number.isFinite(retryAt) ? retryAt : 0),
				);
				return;
			}
			await this.state.storage.delete("retry");
			if (run.phase === "account" || fatal)
				run = { ...run, status: "failed", phase: "done", finishedAt: run.updatedAt };
			else {
				run = { ...run, partial: true, completedRepos: run.completedRepos + 1 };
				if (run.completedRepos >= run.repos.length) run = finish(run);
			}
		}
		await saveRefreshRun(db, run);
		await this.state.blockConcurrencyWhile(async () => {
			if (terminal(run) && !(await activeRefreshRun(db, accountId)))
				await this.state.storage.deleteAlarm();
			else await this.state.storage.setAlarm(Date.now() + 1_000);
		});
	}
}

export async function scheduleRefresh(env: Env, at: number): Promise<void> {
	const accounts = await createDb(env.DB)
		.prepare("SELECT id FROM accounts ORDER BY id")
		.all<{ id: string }>();
	let failures = 0;
	for (const account of accounts.results) {
		try {
			await startRefresh(env, account.id, {}, "scheduled", new Date(at));
		} catch {
			failures++;
		}
	}
	if (failures)
		throw new ApiError(503, "refresh_schedule_failed", `${failures} account schedules failed`);
}
