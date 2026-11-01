import { z } from "zod";
import type { RefreshFailureDetail, RefreshRun } from "../lib/refresh-types";
import { type Env, encryptionKey } from "./env";
import { getAccount } from "./lib/db/accounts";
import { createDb, type Db } from "./lib/db/d1";
import { ApiError, jsonError } from "./lib/errors";
import { savedAnnualCalendarCoverage } from "./lib/refresh-calendar";
import { collectAccount, collectRepository } from "./lib/refresh-collection";
import { catalogRepository, savedAccountPublication } from "./lib/refresh-collection/store";
import { transportFailure } from "./lib/refresh-collection/transport";
import type { AccountCollectionResult, CollectionResult } from "./lib/refresh-collection-contract";
import { parseRefreshParams, refreshDays } from "./lib/refresh-params";
import {
	activeRefreshRun,
	addRefreshPartialReasons,
	addRefreshRequests,
	cancelRefreshRun,
	closeRefreshStep,
	completeRefreshStepAttempt,
	createRefreshRun,
	getRefreshRun,
	type RequestCounts,
	saveRefreshRun,
	scheduledRefreshRun,
	startRefreshStep,
	terminalRefreshStatus,
} from "./lib/refresh-store";
import { decryptToken, parseKeyBytes } from "./lib/token-crypto";
import { requestCancellation } from "./refresh-cancel";

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
const MAX_STEPS_PER_ALARM = 30;
const MAX_INTERRUPTED_ATTEMPTS = 3;
const RECOVERY_MS = 5_000;
const RETRY_DELAYS = [2_000, 5_000, 15_000];
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const failureCode = (error: unknown) =>
	error instanceof ApiError && safeCodes.has(error.code) ? error.code : "refresh_failed";
const terminal = (run: RefreshRun) => terminalRefreshStatus(run.status);
const cancelKey = (id: string) => `cancel:${id}`;
type Retry = {
	key: string;
	attempts: number;
	notBefore: number;
	detail?: RefreshFailureDetail;
	exhausted?: { counted: RequestCounts; detail: RefreshFailureDetail; at: string };
};
type ExecutionAttempt = { key: string; interruptions: number; failedAt?: string };
const executionKey = (run: RefreshRun) => {
	const timing = run.phase === "account" ? run.timings?.a : run.timings?.repos[run.completedRepos];
	return `${run.id}:${run.phase}:${run.completedRepos}:${timing?.attempts ?? 0}`;
};
type StepOutcome =
	| { ok: true; phase: "account"; result: AccountCollectionResult }
	| { ok: true; phase: "repos"; result: CollectionResult; failures: RefreshFailureDetail[] }
	| { ok: false; error: unknown; counted: RequestCounts };
const retryDelay = (code: string, attempts: number) =>
	code === "github_rate_limited"
		? 60_000
		: (RETRY_DELAYS[Math.min(attempts, RETRY_DELAYS.length - 1)] ?? 15_000);
const failureDetail = (code: string, error: unknown): RefreshFailureDetail => {
	const detail = transportFailure(error);
	return {
		dimension: detail?.dimension ?? null,
		code,
		httpStatus: detail
			? detail.httpStatus
			: error instanceof ApiError
				? error.upstreamStatus
				: null,
		graphqlType: detail?.graphqlType ?? null,
		graphqlPath: detail?.graphqlPath ?? null,
	};
};
const shanghaiDate = (iso: string) =>
	new Date(Date.parse(iso) + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
async function reusableAccountA(db: Db, run: RefreshRun): Promise<AccountCollectionResult | null> {
	const name = run.params.repo;
	if (!name || run.params.force) return null;
	const saved = await savedAccountPublication(db, run.accountId);
	if (saved === null || saved.status !== "complete" || !savedAnnualCalendarCoverage(saved).complete)
		return null;
	if (shanghaiDate(saved.fetched_at) !== shanghaiDate(run.updatedAt)) return null;
	const entry = await catalogRepository(db, run.accountId, name);
	if (!entry) throw new ApiError(404, "not_found", "Repository not found in current catalogue");
	return {
		requests: 0,
		requestBreakdown: { graphql: 0, rest: 0 },
		partial: false,
		reasons: [],
		repos: [entry.repo],
		aReused: true,
	};
}
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

function failedStep(
	run: RefreshRun,
	counted: RequestCounts,
	detail: RefreshFailureDetail,
	at: string,
	cancel: boolean,
): RefreshRun {
	const accountPhase = run.phase === "account";
	const repo = accountPhase ? null : (run.repos[run.completedRepos] ?? null);
	let failed = completeRefreshStepAttempt(
		addRefreshRequests(
			{ ...run, errorCode: detail.code, updatedAt: at },
			accountPhase ? "a" : "b",
			counted,
		),
		at,
		true,
	);
	failed =
		accountPhase || fatalCodes.includes(detail.code)
			? cancel
				? failed
				: { ...failed, status: "failed", phase: "done", finishedAt: at }
			: { ...failed, partial: true, completedRepos: failed.completedRepos + 1 };
	return addRefreshPartialReasons(failed, repo, [detail.code], [detail]);
}

export async function startRefresh(
	env: Env,
	accountId: string,
	input: unknown,
	trigger: RefreshRun["trigger"] = "manual",
	at = new Date(),
): Promise<RefreshRun> {
	parseRefreshParams(input, at);
	const response = await dispatch(env, accountId, "/start", {
		accountId,
		params: input,
		trigger,
		at: at.toISOString(),
	});
	return response.json() as Promise<RefreshRun>;
}

export async function cancelRefresh(
	env: Env,
	accountId: string,
	id: string,
	waitUntil: (work: Promise<unknown>) => void,
): Promise<RefreshRun> {
	const run = await requestCancellation({
		db: createDb(env.DB),
		accountId,
		id,
		at: new Date().toISOString(),
		waitUntil,
		wake: () => dispatch(env, accountId, "/cancel", { accountId, id }),
	});
	if (!run) throw new ApiError(404, "not_found", "refresh run missing");
	return run;
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
				if (!active) await this.state.storage.setAlarm(Date.now());
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
			if (alarm === null || alarm > Date.now()) await this.state.storage.setAlarm(Date.now());
			return Response.json(marked, { status: 202 });
		});
	}
	async alarm(): Promise<void> {
		let continuation: { accountId: string; run: RefreshRun } | null = null;
		for (let steps = 0; steps < MAX_STEPS_PER_ALARM; steps++) {
			const db = createDb(this.env.DB);
			const step: { accountId: string; run: RefreshRun } | null =
				await this.state.blockConcurrencyWhile(async () => {
					const accountId = await this.state.storage.get<string>("accountId");
					const active = accountId ? await activeRefreshRun(db, accountId) : null;
					if (!accountId || !active) {
						await this.state.storage.delete("retry");
						await this.state.storage.delete("executing");
						await this.state.storage.deleteAlarm();
						return null;
					}
					const at = new Date().toISOString();
					const retry = await this.state.storage.get<Retry>("retry");
					const cancelling =
						active.cancelRequested ||
						!!(await this.state.storage.get<boolean>(cancelKey(active.id)));
					const sameStep = retry?.key === `${active.id}:${active.phase}:${active.completedRepos}`;
					if (cancelling || (sameStep && retry.exhausted))
						await this.state.storage.setAlarm(Date.now() + RECOVERY_MS);
					if (sameStep && retry.exhausted) {
						const failure = retry.exhausted;
						let resolved = failedStep(
							active,
							failure.counted,
							failure.detail,
							failure.at,
							cancelling,
						);
						if (cancelling) resolved = this.attributedCancellation(resolved, retry, active);
						else if (!terminal(resolved) && resolved.completedRepos >= resolved.repos.length)
							resolved = finish(resolved, failure.at);
						await this.persist(db, accountId, resolved);
						return null;
					}
					if (cancelling) {
						await this.persist(db, accountId, this.attributedCancellation(active, retry));
						return null;
					}
					if (sameStep && retry.notBefore > Date.now()) {
						await this.state.storage.setAlarm(Math.min(retry.notBefore, Date.now() + RECOVERY_MS));
						return null;
					}
					const previous = await this.state.storage.get<ExecutionAttempt>("executing");
					const key = executionKey(active);
					const interruptions = previous?.key === key ? previous.interruptions + 1 : 0;
					const failedAt =
						interruptions >= MAX_INTERRUPTED_ATTEMPTS ? (previous?.failedAt ?? at) : undefined;
					await this.state.storage.put("executing", {
						key,
						interruptions,
						...(failedAt ? { failedAt } : {}),
					});
					if (failedAt) {
						await this.state.storage.setAlarm(Date.now() + RECOVERY_MS);
						let resolved = failedStep(
							active,
							{ graphql: 0, rest: 0 },
							failureDetail("refresh_interrupted", null),
							failedAt,
							false,
						);
						if (!terminal(resolved) && resolved.completedRepos >= resolved.repos.length)
							resolved = finish(resolved, failedAt);
						await this.persist(db, accountId, resolved);
						return null;
					}
					if (continuation?.run.id === active.id) return { accountId, run: active };
					const run = startRefreshStep(
						{ ...active, status: "running" as const, updatedAt: at },
						at,
					);
					await this.state.storage.setAlarm(Date.now() + RECOVERY_MS);
					await saveRefreshRun(db, run);
					return { accountId, run };
				});
			if (!step) return;
			const outcome = await this.collect(step.run);
			continuation = await this.state.blockConcurrencyWhile(() =>
				this.settle(db, step, outcome, steps + 1 < MAX_STEPS_PER_ALARM),
			);
			if (!continuation) return;
		}
	}
	private async collect(run: RefreshRun): Promise<StepOutcome> {
		let counted: RequestCounts = { graphql: 0, rest: 0 };
		let failures: RefreshFailureDetail[] = [];
		try {
			const db = createDb(this.env.DB);
			const account = await getAccount(db, run.accountId);
			if (!account) throw new ApiError(404, "account_missing", "account missing");
			if (run.phase === "account") {
				const reused = await reusableAccountA(db, run);
				if (reused) return { ok: true, phase: "account", result: reused };
			}
			const key = encryptionKey(this.env, account.key_version);
			if (!key) throw new ApiError(500, "encryption_misconfigured", "encryption unavailable");
			const token = await decryptToken(account.token_ciphertext, parseKeyBytes(key));
			const context = {
				onRequests: (_count: number, breakdown: RequestCounts) => {
					counted = breakdown;
				},
				onFailures: (details: RefreshFailureDetail[]) => {
					failures = details;
				},
				env: this.env,
				account,
				token,
				run,
				days: refreshDays(run.params),
				now: run.updatedAt,
				publishFactorySnapshot: run.phase !== "account",
			};
			if (run.phase === "account")
				return { ok: true, phase: "account", result: await collectAccount(context) };
			const repo = run.repos[run.completedRepos];
			if (!repo) throw new ApiError(500, "validation_failed", "repository cursor invalid");
			return {
				ok: true,
				phase: "repos",
				result: await collectRepository(context, repo),
				failures,
			};
		} catch (error) {
			return { ok: false, error, counted };
		}
	}
	private async settle(
		db: Db,
		step: { accountId: string; run: RefreshRun },
		outcome: StepOutcome,
		canContinue: boolean,
	): Promise<{ accountId: string; run: RefreshRun } | null> {
		const at = new Date().toISOString();
		const stored = await getRefreshRun(db, step.accountId, step.run.id);
		const cancellationRequested =
			stored?.cancelRequested || (await this.state.storage.get<boolean>(cancelKey(step.run.id)));
		const accountPhase = step.run.phase === "account";
		const repo = accountPhase ? null : (step.run.repos[step.run.completedRepos] ?? null);
		let run: RefreshRun = { ...step.run, updatedAt: at };
		let retryAt: number | null = null;
		let pending: Retry | undefined;
		if (outcome.ok) {
			run = addRefreshRequests(run, accountPhase ? "a" : "b", outcome.result.requestBreakdown);
			run = {
				...run,
				errorCode: null,
				...(!accountPhase
					? {}
					: { aReused: outcome.phase === "account" && outcome.result.aReused === true }),
			};
			run = completeRefreshStepAttempt(
				run,
				at,
				true,
				outcome.phase === "account" && outcome.result.aReused === true,
			);
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
				outcome.phase === "repos" && outcome.result.partial ? outcome.failures : [],
			);
		} else {
			const code = failureCode(outcome.error);
			const retry = await this.state.storage.get<Retry>("retry");
			const key = `${run.id}:${step.run.phase}:${step.run.completedRepos}`;
			const attempts = retry?.key === key ? retry.attempts : 0;
			const fatal = fatalCodes.includes(code);
			const detail = failureDetail(code, outcome.error);
			if (!fatal) {
				const deadline =
					outcome.error instanceof ApiError && outcome.error.retryAt
						? Date.parse(outcome.error.retryAt)
						: 0;
				const notBefore = Math.max(
					Date.now() + retryDelay(code, attempts),
					Number.isFinite(deadline) ? deadline : 0,
				);
				const recorded: Retry = {
					key,
					attempts: attempts + 1,
					notBefore,
					detail,
					...(attempts < RETRY_LIMIT
						? {}
						: { exhausted: { counted: outcome.counted, detail, at } }),
				};
				await this.state.storage.put("retry", recorded);
				if (attempts < RETRY_LIMIT) {
					pending = recorded;
					retryAt = notBefore;
				}
			}
			run =
				pending === undefined
					? failedStep(run, outcome.counted, detail, at, !!cancellationRequested)
					: completeRefreshStepAttempt(
							addRefreshRequests(
								{ ...run, errorCode: code },
								accountPhase ? "a" : "b",
								outcome.counted,
							),
							at,
							false,
						);
		}
		if (cancellationRequested) {
			run = this.attributedCancellation(run, pending, step.run);
			retryAt = null;
		} else if (retryAt === null && !terminal(run) && run.completedRepos >= run.repos.length)
			run = finish(run, at);
		if (stored && terminal(stored))
			run = {
				...run,
				status: stored.status,
				phase: "done",
				cancelRequested: stored.cancelRequested,
				finishedAt: stored.finishedAt,
			};
		const continuing = canContinue && !cancellationRequested && retryAt === null && !terminal(run);
		if (continuing) {
			run = startRefreshStep(run, at);
			await this.state.storage.setAlarm(Date.now() + RECOVERY_MS);
		}
		await this.persist(db, step.accountId, run, retryAt, continuing);
		return continuing ? { accountId: step.accountId, run } : null;
	}
	private attributedCancellation(
		run: RefreshRun,
		retry: Retry | undefined,
		step = run,
	): RefreshRun {
		const at = new Date().toISOString();
		const cancelled = cancelRefreshRun(closeRefreshStep(run, at), at);
		if (!run.errorCode) return cancelled;
		const repo = step.phase === "account" ? null : (step.repos[step.completedRepos] ?? null);
		const pending = `${step.id}:${step.phase}:${step.completedRepos}`;
		const detail = retry?.key === pending ? retry.detail : undefined;
		return addRefreshPartialReasons(cancelled, repo, [run.errorCode], detail ? [detail] : []);
	}
	private async persist(
		db: Db,
		accountId: string,
		run: RefreshRun,
		retryAt: number | null = null,
		continuing = false,
	): Promise<void> {
		const saved = await saveRefreshRun(db, run);
		await this.state.storage.delete("executing");
		if (!saved) return this.wake(db, accountId);
		if (retryAt === null || terminal(saved)) await this.state.storage.delete("retry");
		if (terminal(saved)) await this.state.storage.delete(cancelKey(saved.id));
		if (saved.cancelRequested && !terminal(saved)) await this.state.storage.setAlarm(Date.now());
		else if (retryAt !== null)
			await this.state.storage.setAlarm(Math.min(retryAt, Date.now() + RECOVERY_MS));
		else if (!continuing || terminal(saved)) await this.wake(db, accountId);
	}
	private async wake(db: Db, accountId: string, urgent = true): Promise<void> {
		if (!(await activeRefreshRun(db, accountId))) {
			await this.state.storage.deleteAlarm();
			return;
		}
		if (!urgent && (await this.state.storage.getAlarm()) !== null) return;
		await this.state.storage.setAlarm(Date.now());
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
