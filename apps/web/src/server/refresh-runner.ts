import { z } from "zod";
import type { RefreshRun } from "../lib/refresh-types";
import { type Env, encryptionKey } from "./env";
import { getAccount } from "./lib/db/accounts";
import { createDb, type Db } from "./lib/db/d1";
import { ApiError, jsonError } from "./lib/errors";
import { collectAccount, collectRepository } from "./lib/refresh-collection";
import type { AccountCollectionResult, CollectionResult } from "./lib/refresh-collection-contract";
import { parseRefreshParams, refreshDays } from "./lib/refresh-params";
import {
	activeRefreshRun,
	addRefreshPartialReasons,
	addRefreshRequests,
	cancelRefreshRun,
	createRefreshRun,
	getRefreshRun,
	type RequestCounts,
	saveRefreshRun,
	scheduledRefreshRun,
	terminalRefreshStatus,
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
const cancelSchema = z
	.object({ accountId: z.string().min(1).max(100), id: z.string().min(1).max(100) })
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
const fatalCodes = [
	"github_unauthorized",
	"encryption_misconfigured",
	"account_missing",
	"not_found",
	"validation_failed",
];
const RETRY_LIMIT = 3;
const failureCode = (error: unknown) =>
	error instanceof ApiError && safeCodes.has(error.code) ? error.code : "refresh_failed";
const terminal = (run: RefreshRun) => terminalRefreshStatus(run.status);
const cancelKey = (id: string) => `cancel:${id}`;
type Retry = { key: string; attempts: number };
type StepOutcome =
	| { ok: true; phase: "account"; result: AccountCollectionResult }
	| { ok: true; phase: "repos"; result: CollectionResult }
	| { ok: false; error: unknown; counted: RequestCounts };
function finish(run: RefreshRun, at: string): RefreshRun {
	return {
		...run,
		phase: "done",
		status: run.partial ? "partial" : "completed",
		errorCode: run.partial ? run.errorCode : null,
		updatedAt: at,
		finishedAt: at,
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
	const response = await dispatch(env, accountId, "/start", {
		accountId,
		params,
		trigger,
		at: at.toISOString(),
	});
	return response.json() as Promise<RefreshRun>;
}

export async function cancelRefresh(env: Env, accountId: string, id: string): Promise<RefreshRun> {
	const response = await dispatch(env, accountId, "/cancel", { accountId, id });
	return response.json() as Promise<RefreshRun>;
}

async function dispatch(
	env: Env,
	accountId: string,
	path: string,
	body: unknown,
): Promise<Response> {
	if (!env.REFRESH_RUNNER)
		throw new ApiError(503, "refresh_unavailable", "refresh runner binding unavailable");
	const response = await env.REFRESH_RUNNER.getByName(accountId).fetch(
		new Request(`https://refresh.internal${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	if (!response.ok) {
		const failure = (await response.json()) as { error: { code: string } };
		throw new ApiError(response.status, failure.error.code, "refresh request rejected");
	}
	return response;
}

export class RefreshRunner implements DurableObject {
	constructor(
		private readonly state: DurableObjectState,
		private readonly env: Env,
	) {}
	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST")
			return jsonError(405, "method_not_allowed", "method not allowed");
		const path = new URL(request.url).pathname;
		try {
			if (path === "/cancel") return await this.cancel(await request.json());
			if (path !== "/start") throw new ApiError(404, "not_found", "unknown refresh route");
			const body = startSchema.safeParse(await request.json());
			if (!body.success) throw new ApiError(400, "validation_failed", "invalid refresh request");
			const { accountId, trigger, at } = body.data;
			const params = parseRefreshParams(body.data.params, new Date(at));
			return await this.state.blockConcurrencyWhile(async () => {
				const db = createDb(this.env.DB);
				await this.requireAccount(db, accountId);
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
				"refresh request rejected",
			);
		}
	}
	private async requireAccount(db: Db, accountId: string) {
		if (!(await getAccount(db, accountId)))
			throw new ApiError(404, "account_missing", "account missing");
		const stored = await this.state.storage.get<string>("accountId");
		if (stored && stored !== accountId)
			throw new ApiError(400, "validation_failed", "account mismatch");
		await this.state.storage.put("accountId", accountId);
	}
	private async cancel(body: unknown): Promise<Response> {
		const parsed = cancelSchema.safeParse(body);
		if (!parsed.success) throw new ApiError(400, "validation_failed", "invalid cancel request");
		const { accountId, id } = parsed.data;
		const at = new Date().toISOString();
		return this.state.blockConcurrencyWhile(async () => {
			const db = createDb(this.env.DB);
			await this.requireAccount(db, accountId);
			const run = await getRefreshRun(db, accountId, id);
			if (!run) return jsonError(404, "not_found", "refresh run missing");
			if (terminal(run)) return Response.json(run);
			await this.state.storage.put(cancelKey(id), true);
			if (run.status === "queued") {
				const cancelled = cancelRefreshRun(run, at);
				await saveRefreshRun(db, cancelled);
				await this.state.storage.delete(cancelKey(id));
				await this.wake(db, accountId, false);
				return Response.json(cancelled);
			}
			const marked = { ...run, cancelRequested: true, updatedAt: at };
			await saveRefreshRun(db, marked);
			const alarm = await this.state.storage.getAlarm();
			if (alarm === null || alarm > Date.now() + 1_000)
				await this.state.storage.setAlarm(Date.now() + 1_000);
			return Response.json(marked, { status: 202 });
		});
	}
	async alarm(): Promise<void> {
		const db = createDb(this.env.DB);
		const step = await this.state.blockConcurrencyWhile(async () => {
			const accountId = await this.state.storage.get<string>("accountId");
			const active = accountId ? await activeRefreshRun(db, accountId) : null;
			if (!accountId || !active) {
				await this.state.storage.deleteAlarm();
				return null;
			}
			const at = new Date().toISOString();
			if (await this.state.storage.get<boolean>(cancelKey(active.id))) {
				await this.persist(db, accountId, cancelRefreshRun(active, at));
				return null;
			}
			const run = { ...active, status: "running" as const, updatedAt: at };
			await saveRefreshRun(db, run);
			await this.state.storage.setAlarm(Date.now() + 5 * 60_000);
			return { accountId, run };
		});
		if (!step) return;
		const outcome = await this.collect(step.run);
		await this.state.blockConcurrencyWhile(() => this.settle(db, step, outcome));
	}
	private async collect(run: RefreshRun): Promise<StepOutcome> {
		let counted: RequestCounts = { graphql: 0, rest: 0 };
		try {
			const db = createDb(this.env.DB);
			const account = await getAccount(db, run.accountId);
			if (!account) throw new ApiError(404, "account_missing", "account missing");
			const key = encryptionKey(this.env, account.key_version);
			if (!key) throw new ApiError(500, "encryption_misconfigured", "encryption unavailable");
			const token = await decryptToken(account.token_ciphertext, parseKeyBytes(key));
			const context = {
				onRequests: (_count: number, breakdown: RequestCounts) => {
					counted = breakdown;
				},
				env: this.env,
				account,
				token,
				run,
				days: refreshDays(run.params),
				now: run.updatedAt,
			};
			if (run.phase === "account")
				return { ok: true, phase: "account", result: await collectAccount(context) };
			const repo = run.repos[run.completedRepos];
			if (!repo) throw new ApiError(500, "validation_failed", "repository cursor invalid");
			return { ok: true, phase: "repos", result: await collectRepository(context, repo) };
		} catch (error) {
			return { ok: false, error, counted };
		}
	}
	private async settle(
		db: Db,
		step: { accountId: string; run: RefreshRun },
		outcome: StepOutcome,
	): Promise<void> {
		const at = new Date().toISOString();
		const cancellationRequested = await this.state.storage.get<boolean>(cancelKey(step.run.id));
		const accountPhase = step.run.phase === "account";
		const repo = accountPhase ? null : (step.run.repos[step.run.completedRepos] ?? null);
		let run: RefreshRun = { ...step.run, updatedAt: at };
		let retryAt: number | null = null;
		if (outcome.ok) {
			run = addRefreshRequests(run, accountPhase ? "a" : "b", outcome.result.requestBreakdown);
			run =
				outcome.phase === "account"
					? { ...run, phase: "repos", repos: outcome.result.repos }
					: { ...run, completedRepos: run.completedRepos + 1 };
			const reasons =
				outcome.result.partial && !outcome.result.reasons.length
					? ["collection:partial"]
					: outcome.result.reasons;
			run = addRefreshPartialReasons(
				{ ...run, partial: run.partial || outcome.result.partial },
				repo,
				reasons,
			);
			await this.state.storage.delete("retry");
		} else {
			const code = failureCode(outcome.error);
			const retry = await this.state.storage.get<Retry>("retry");
			const key = `${run.id}:${step.run.phase}:${step.run.completedRepos}`;
			const attempts = retry?.key === key ? retry.attempts : 0;
			const fatal = fatalCodes.includes(code);
			run = addRefreshRequests(
				{ ...run, errorCode: code },
				accountPhase ? "a" : "b",
				outcome.counted,
			);
			if (!fatal && attempts < RETRY_LIMIT) {
				await this.state.storage.put("retry", { key, attempts: attempts + 1 });
				const deadline =
					outcome.error instanceof ApiError && outcome.error.retryAt
						? Date.parse(outcome.error.retryAt)
						: 0;
				retryAt = Math.max(
					Date.now() + 60_000 * 2 ** attempts,
					Number.isFinite(deadline) ? deadline : 0,
				);
			} else {
				await this.state.storage.delete("retry");
				run =
					accountPhase || fatal
						? cancellationRequested
							? run
							: { ...run, status: "failed", phase: "done", finishedAt: at }
						: addRefreshPartialReasons(
								{ ...run, partial: true, completedRepos: run.completedRepos + 1 },
								repo,
								[code],
							);
			}
		}
		if (cancellationRequested) {
			run = cancelRefreshRun(run, at);
			retryAt = null;
			await this.state.storage.delete("retry");
		} else if (retryAt === null && !terminal(run) && run.completedRepos >= run.repos.length)
			run = finish(run, at);
		const stored = await getRefreshRun(db, step.accountId, run.id);
		if (stored && terminal(stored))
			run = {
				...run,
				status: stored.status,
				phase: "done",
				cancelRequested: stored.cancelRequested,
				finishedAt: stored.finishedAt,
			};
		await this.persist(db, step.accountId, run, retryAt);
	}
	private async persist(
		db: Db,
		accountId: string,
		run: RefreshRun,
		retryAt: number | null = null,
		urgent = true,
	): Promise<void> {
		await saveRefreshRun(db, run);
		if (terminal(run)) await this.state.storage.delete(cancelKey(run.id));
		if (retryAt !== null) await this.state.storage.setAlarm(retryAt);
		else await this.wake(db, accountId, urgent);
	}
	private async wake(db: Db, accountId: string, urgent = true): Promise<void> {
		if (!(await activeRefreshRun(db, accountId))) {
			await this.state.storage.deleteAlarm();
			return;
		}
		if (!urgent && (await this.state.storage.getAlarm()) !== null) return;
		await this.state.storage.setAlarm(Date.now() + 1_000);
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
