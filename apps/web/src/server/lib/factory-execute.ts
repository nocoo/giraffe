import {
	completedRunStatus,
	type FactoryRunStep,
	RUN_MAX_RETRIES,
	retryDelay,
} from "../../lib/factory-run";
import {
	FACTORY_STREAMS,
	type FactoryStreamData,
	type FactoryStreamName,
} from "../../lib/factory-types";
import { type Env, encryptionKey } from "../env";
import { activityBranch } from "./activity";
import {
	type ActivitySupplement,
	collectActivityContributions,
	collectActivitySupplement,
} from "./activity-collect";
import { freezeActivityRepo } from "./activity-store";
import { savedContentMeta } from "./content-version";
import { getAccount } from "./db/accounts";
import { createDb, type Db } from "./db/d1";
import { beginRunStep } from "./db/factory-run-journal";
import {
	claimRun,
	expireRuns,
	fenced,
	nextRunAttempt,
	type RunLease,
	releaseRunLease,
	saveRun,
} from "./db/factory-runs";
import { ApiError } from "./errors";
import { cachedActionsClient, stepActions } from "./factory-actions";
import { newFactory, stepFactory } from "./factory-collect";
import {
	FactoryInvocation,
	INVOCATION_DB_STATEMENTS,
	InvocationStopped,
} from "./factory-invocation";
import { type FactoryEndReason, logFactory } from "./factory-log";
import { exclusion, mapFactoryRepo, object } from "./factory-map";
import { executeRepoPool, type PoolStepHooks, poolSteps } from "./factory-pool";
import {
	boundedJson,
	currentRepo,
	publicationWrites,
	repositoryWrites,
	restoreLegacyRepo,
} from "./factory-publish";
import { FACTORY_REPO_QUERY } from "./factory-queries";
import { recordFactoryRate } from "./factory-rate";
import { collectSitePage } from "./factory-site";
import { createGithubClient } from "./github-client";
import { assertRefreshCapabilities } from "./refresh";
import { repoPolicy } from "./snapshot-projection";
import { decryptToken, parseKeyBytes } from "./token-crypto";

export async function executeRunPage(
	env: Env,
	id: string,
	clock = () => new Date().toISOString(),
): Promise<string | null> {
	const db = createDb(env.DB, undefined, INVOCATION_DB_STATEMENTS);
	const started = Date.parse(clock());
	let lease: RunLease | null = null;
	let invocation: FactoryInvocation | null = null;
	let reason: FactoryEndReason = "run_end";
	let operation: "claim" | "heartbeat" | "step" | "save" = "claim";
	let failure: unknown;
	let cursorStart = 0;
	let stepsDone = 0;
	let stagedWrites = 0;
	try {
		lease = await claimRun(db, id, new Date(started).toISOString(), false);
		if (!lease) {
			await expireRuns(db, clock(), "", id);
			return await nextRunAttempt(db, id);
		}
		const run = lease.run;
		cursorStart = run.cursor;
		invocation = new FactoryInvocation(db, lease, clock);
		const retired = run.steps.filter(
			(step) => String(step.kind) === "assessment" && ["pending", "running"].includes(step.status),
		);
		if (retired.length) {
			const now = clock();
			for (const step of retired) {
				finish(step, "skipped", now);
				step.error = "cloud_ai_retired";
			}
			while (
				run.steps[run.cursor] &&
				!["pending", "running"].includes(run.steps[run.cursor]?.status ?? "")
			)
				run.cursor++;
			run.nextAttemptAt = now;
			operation = "save";
			return (await saveRun(db, lease, [], clock())) ? now : null;
		}
		for (;;) {
			while (
				run.steps[run.cursor] &&
				!["pending", "running"].includes(run.steps[run.cursor]?.status ?? "")
			)
				run.cursor++;
			const step = run.steps[run.cursor];
			if (!step) {
				run.status = completedRunStatus(run);
				run.finishedAt = clock();
				reason = "completed";
				break;
			}
			const repositories = poolSteps(run);
			if (repositories.size) {
				const activeInvocation = invocation;
				await executeRepoPool(
					db,
					lease,
					invocation,
					repositories,
					(poolDb, lane, current, hooks) =>
						executeStep(env, poolDb, lane, activeInvocation, current, clock, hooks),
					(value) => {
						operation = value;
					},
					(steps, writes) => {
						stepsDone += steps;
						stagedWrites += writes;
					},
				);
				reason = invocation.endReason(step, true) ?? "yield";
				if (run.status !== "running") return null;
				break;
			}
			if (!invocation.canStart(step)) {
				reason = invocation.endReason(step) ?? "yield";
				if (step.status === "running") step.status = "pending";
				break;
			}
			operation = "heartbeat";
			await invocation.heartbeat();
			operation = "step";
			const result = await executeStep(env, db, lease, invocation, step, clock);
			invocation.writes.push(...result.writes);
			stagedWrites += result.writes.length;
			const boundary = invocation.completed(step);
			if (!["pending", "running"].includes(step.status)) stepsDone++;
			operation = "save";
			if (!(await saveRun(db, lease, invocation.writes, clock(), run.status === "running"))) {
				reason = "save_failed";
				return await nextRunAttempt(db, id);
			}
			invocation.writes.length = 0;
			if (run.status !== "running") {
				reason = run.finishedAt ? "completed" : "run_end";
				return null;
			}
			if (result.stop || boundary || run.nextAttemptAt > clock()) {
				reason = result.stop || boundary ? "yield" : "run_end";
				break;
			}
		}
		operation = "save";
		const saved = await saveRun(db, lease, [], clock());
		if (!saved) reason = "save_failed";
		return saved && run.status === "running" ? run.nextAttemptAt : null;
	} catch (error) {
		failure = error;
		reason = operation === "save" ? "save_failed" : "error";
		if (lease) {
			try {
				await releaseRunLease(createDb(env.DB), lease, clock());
			} catch (releaseError) {
				logFactory("factory_lease_release_error", { runId: id }, releaseError);
			}
		}
		if (error instanceof InvocationStopped && error.lostLease) {
			reason = "lost_lease";
			await expireRuns(db, clock(), "", id);
			return await nextRunAttempt(db, id);
		}
		throw error;
	} finally {
		logFactory(
			"factory_invocation",
			{
				runId: id,
				cursorStart,
				cursorEnd: lease?.run.cursor ?? cursorStart,
				stepsDone,
				requests: invocation?.requests ?? 0,
				statements: db.statements,
				stagedWrites,
				elapsedMs: Math.max(0, Date.parse(clock()) - started),
				endReason: reason,
				operation,
			},
			failure,
		);
	}
}

async function executeStep(
	env: Env,
	db: Db,
	lease: RunLease,
	invocation: FactoryInvocation,
	step: FactoryRunStep,
	clock: () => string,
	hooks?: PoolStepHooks,
) {
	const run = lease.run;
	const started = clock();
	const interrupted = step.error === "worker_interrupted";
	const savedPages = step.pages;
	const savedSnapshotCursor = step.snapshotCursor;
	step.startedAt ??= started;
	step.attempts = step.error ? step.attempts + 1 : Math.max(1, step.attempts);
	step.status = "running";
	step.error = null;
	if (!(await (hooks ? hooks.begin(step) : beginRunStep(db, lease, clock()))))
		throw new InvocationStopped(true);
	const before = structuredClone(run.checkpoint);
	const gh = createGithubClient(env, undefined, 4_000_000, () =>
		invocation.beforeRequest(hooks?.heartbeat),
	);
	let writes: D1PreparedStatement[] = [];
	let resourceData: FactoryStreamData | null = null;
	const resourceKey = `${step.repo}:${step.kind}`;
	let stop = false;
	try {
		if (interrupted && (step.retryFailures ?? 0) > RUN_MAX_RETRIES)
			throw new ApiError(500, "worker_interrupted", "worker interrupted repeatedly");
		if (step.kind === "metadata") {
			const state = await db
				.prepare("SELECT payload FROM factory_repo_state WHERE account_id=? AND repo=?")
				.bind(run.account_id, step.repo)
				.first<{ payload: string }>();
			const previousAttempt = state
				? (JSON.parse(state.payload) as { nextAllowedAt: string; attemptRunId?: string })
				: null;
			if (
				previousAttempt &&
				!run.schedule &&
				previousAttempt.nextAllowedAt > clock() &&
				previousAttempt.attemptRunId !== run.id
			)
				throw new ApiError(409, "repository_cooldown", "repository cooldown");
		}
		let token = "";
		if (!["restore", "commit", "publish"].includes(step.kind) && step.resource !== "insights") {
			const account = await getAccount(db, run.account_id);
			if (!account) throw new ApiError(409, "account_missing", "account missing");
			if (step.kind === "snapshot")
				assertRefreshCapabilities(account.capabilities, [step.resource ?? ""]);
			const key = encryptionKey(env, account.key_version);
			if (!key) throw new ApiError(500, "encryption_key_missing", "encryption key missing");
			token = await decryptToken(account.token_ciphertext, parseKeyBytes(key));
		}
		if (step.kind === "activity-contributions") {
			if (!run.activityWindow) finish(step, "skipped", clock());
			else {
				run.activityContributions = await collectActivityContributions(run, gh, token);
				finish(
					step,
					run.activityContributions.days.some((day) => day.coverage.status !== "unavailable")
						? "success"
						: "unavailable",
					clock(),
				);
			}
		} else if (step.kind === "activity") {
			const repo = await currentRepo(db, run.account_id, String(step.repo));
			if (!repo || !run.activityWindow) finish(step, "unavailable", clock());
			else {
				const saved = await db
					.prepare(
						"SELECT stream,payload FROM factory_resources WHERE run_id=? AND repo=? AND stream IN ('activity','actions')",
					)
					.bind(run.id, repo.name)
					.all<{ stream: string; payload: string }>();
				const previous = saved.results.find((row) => row.stream === "activity");
				const actions = saved.results.find((row) => row.stream === "actions");
				const result = await collectActivitySupplement(
					run,
					{ ...repo, branch: activityBranch(run, repo) },
					await cachedActionsClient(db, lease, repo.name, gh),
					token,
					previous ? (JSON.parse(previous.payload) as ActivitySupplement) : null,
					actions ? (JSON.parse(actions.payload) as FactoryStreamData) : null,
				);
				writes.push(
					fenced(
						db,
						lease,
						clock(),
						"INSERT INTO factory_resources(run_id,repo,stream,payload) SELECT ?,?,'activity',? WHERE $guard ON CONFLICT(run_id,repo,stream) DO UPDATE SET payload=excluded.payload",
						[run.id, repo.name, boundedJson(result.state)],
					),
				);
				if (result.done) {
					writes.push(await freezeActivityRepo(db, lease, clock(), repo, result.state));
					finish(
						step,
						Object.values(result.state.coverage).some((value) => value.truncated)
							? "limited"
							: "success",
						clock(),
					);
				}
			}
		} else if (step.kind === "snapshot") {
			const result = await collectSitePage(
				db,
				lease,
				step,
				gh,
				token,
				clock(),
				hooks?.project,
				hooks?.heartbeat ?? (() => invocation.heartbeat()),
			);
			writes = result.writes;
			if (result.done) {
				finish(step, result.unavailable ? "unavailable" : "success", clock());
				if (result.unavailable)
					step.error =
						result.reasonCode && result.reasonCode !== "unknown"
							? result.reasonCode
							: "snapshot_unavailable";
			}
		} else if (step.kind === "metadata") {
			const [owner, name] = String(step.repo).split("/");
			const data = await gh.githubGraphql(token, FACTORY_REPO_QUERY, { owner, name });
			const repo = object(data.repository);
			if (gh.graphqlErrors.length)
				throw new ApiError(403, "github_forbidden", "repository access unavailable");
			if (
				exclusion(repo, run.owner) ||
				!(await repoPolicy(db, run.account_id)).includes(String(step.repo)) ||
				repo.id !== run.repoIds[String(step.repo)]
			)
				throw new ApiError(403, "repository_unavailable", "repository identity/access changed");
			const metadata = mapFactoryRepo(repo);
			step.sourceHead = metadata.head;
			step.sourceBranch = metadata.branch;
			const previous = run.checkpoint;
			run.checkpoint = newFactory(run.account_id, run.owner, run.startedAt);
			run.checkpoint.window = run.window;
			run.checkpoint.runId = run.id;
			run.checkpoint.inventory.complete = true;
			run.checkpoint.repos = [{ ...metadata, metadataAt: clock() }];
			run.checkpoint.contributionStatus = previous?.contributionStatus ?? "unavailable";
			run.checkpoint.contribution = previous?.contribution ?? null;
			run.checkpoint.rate = previous?.rate ?? null;
			if (previous?.rateLimits) run.checkpoint.rateLimits = previous.rateLimits;
			const rate = object(data.rateLimit);
			if (typeof rate.remaining === "number")
				recordFactoryRate(run.checkpoint, {
					remaining: rate.remaining,
					resetAt: typeof rate.resetAt === "string" ? rate.resetAt : null,
					resource: "graphql",
					observedAt: clock(),
				});
			finish(step, "success", clock());
		} else if (step.kind === "restore") {
			const repo = run.checkpoint?.repos[run.restoreCursor];
			if (repo) {
				writes = await restoreLegacyRepo(db, lease, clock(), repo);
				run.restoreCursor++;
			}
			if (run.restoreCursor >= (run.checkpoint?.repos.length ?? 0))
				finish(step, "success", clock());
		} else if (step.kind === "commit") {
			const repo = run.checkpoint?.repos[0];
			if (!repo || repo.name !== step.repo)
				throw new ApiError(500, "checkpoint_invalid", "repository checkpoint missing");
			repo.observation = {
				version: run.id,
				window: run.window,
				refreshedAt: clock(),
				source: "run",
				metadataAt:
					run.steps.find((s) => s.kind === "metadata" && s.repo === repo.name)?.finishedAt ??
					run.startedAt,
			};
			writes = await repositoryWrites(db, lease, clock(), repo, repo.name, null);
			finish(step, "success", clock());
		} else if (step.kind === "publish") {
			const publishedAt = clock();
			writes = await publicationWrites(db, lease, publishedAt);
			finish(step, "success", clock());
			run.status = completedRunStatus(run);
			run.finishedAt = clock();
			run.publishedAt = run.atomicPublication ? publishedAt : null;
		} else {
			run.checkpoint ??= newFactory(run.account_id, run.owner, run.startedAt);
			const checkpoint = run.checkpoint;
			checkpoint.window = run.window;
			if (run.activityWindow) checkpoint.activityWindow = run.activityWindow;
			checkpoint.runId = run.id;
			if (step.kind === "contributions") {
				checkpoint.inventory.complete = true;
				checkpoint.contributionStatus = "pending";
			}
			const stream = FACTORY_STREAMS.includes(step.kind as FactoryStreamName)
				? (step.kind as FactoryStreamName)
				: null;
			if (stream) {
				checkpoint.cursor = { repo: 0, stream: FACTORY_STREAMS.indexOf(stream) };
				checkpoint.status = "collecting";
			}
			const store = {
				...(stream && (run.depth === "quick" || stream === "issues" || stream === "prs")
					? {
							baseline: async () => {
								const repo = await currentRepo(db, run.account_id, String(step.repo));
								if (!repo?.observation || repo.id !== run.repoIds[String(step.repo)]) return null;
								const retained = repo.coverage[stream].observation;
								if (
									(stream === "issues" || stream === "prs") &&
									(retained ||
										repo.coverage[stream].retained ||
										repo.coverage[stream].status !== "complete")
								)
									return null;
								const row = await db
									.prepare(
										"SELECT payload FROM factory_resources WHERE run_id=? AND repo=? AND stream=?",
									)
									.bind(
										repo.observation.version,
										repo.observation.repo ?? step.repo,
										retained ? `retained:${stream}` : stream,
									)
									.first<{ payload: string }>();
								if (!row) return null;
								const data = JSON.parse(row.payload) as FactoryStreamData;
								if (stream === "dependencies")
									data.manifests = [...(repo.manifests ?? []), ...(data.manifests ?? [])];
								return {
									data,
									head: retained ? retained.head : repo.head,
									window: retained?.window ?? repo.observation.window,
								};
							},
						}
					: {}),
				read: async () => {
					const cached = invocation.resources.get(resourceKey);
					if (cached) return structuredClone(cached);
					const row = await db
						.prepare("SELECT payload FROM factory_resources WHERE run_id=? AND repo=? AND stream=?")
						.bind(run.id, step.repo, stream)
						.first<{ payload: string }>();
					return row ? (JSON.parse(row.payload) as FactoryStreamData) : null;
				},
				write: async (_key: string, data: FactoryStreamData) => {
					resourceData = data;
					const metadata = await savedContentMeta(
						`factory:${step.repo}:${stream}`,
						data,
						checkpoint.window,
					);
					writes.push(
						fenced(
							db,
							lease,
							clock(),
							"INSERT INTO factory_resources(run_id,repo,stream,payload,content_meta) SELECT ?,?,?,?,? WHERE $guard ON CONFLICT(run_id,repo,stream) DO UPDATE SET payload=excluded.payload,content_meta=excluded.content_meta",
							[run.id, step.repo, stream, boundedJson(data), metadata],
						),
					);
				},
			};
			if (stream === "actions")
				writes.push(...(await stepActions(db, lease, checkpoint, gh, token, store, clock())));
			else await stepFactory(checkpoint, gh, token, store, clock());
			if (step.kind === "inventory") {
				if (checkpoint.repos.length > 500)
					throw new ApiError(422, "factory_capacity", "catalog exceeds 500 repositories");
				if (checkpoint.inventory.complete) finish(step, "success", clock());
			} else if (step.kind === "contributions") {
				if (checkpoint.contributionStatus !== "pending")
					finish(
						step,
						checkpoint.contributionStatus === "complete"
							? "success"
							: gh.graphqlErrors.length
								? "unavailable"
								: "failed",
						clock(),
					);
				if (checkpoint.contributionStatus === "unavailable")
					step.error = gh.graphqlErrors.length ? "coverage_unavailable" : "snapshot_incomplete";
			} else if (stream) {
				const coverage = checkpoint.repos[0]?.coverage[stream];
				if (coverage && coverage.status !== "partial") {
					if (coverage.strategy) step.strategy = coverage.strategy;
					finish(
						step,
						coverage.status === "complete"
							? "success"
							: coverage.status === "unavailable"
								? "unavailable"
								: coverage.status === "limited" &&
										(coverage.reason_code === undefined ||
											coverage.reason_code === "dependency_parse_unsupported")
									? "limited"
									: "failed",
						clock(),
					);
					if (coverage.status !== "complete")
						step.error =
							coverage.reason_code && coverage.reason_code !== "unknown"
								? coverage.reason_code
								: `coverage_${coverage.status}`;
				}
			}
		}
		step.pages += gh.count;
		step.retryFailures = 0;
		boundedJson(run);
		run.nextAttemptAt = clock();
		if (resourceData) invocation.resources.set(resourceKey, resourceData);
	} catch (error) {
		if (error instanceof InvocationStopped && error.lostLease) throw error;
		if (before && run.checkpoint) {
			before.rate = run.checkpoint.rate;
			if (run.checkpoint.rateLimits) before.rateLimits = run.checkpoint.rateLimits;
		}
		run.checkpoint = before;
		step.pages = savedPages;
		if (savedSnapshotCursor === undefined) delete step.snapshotCursor;
		else step.snapshotCursor = savedSnapshotCursor;
		step.finishedAt = null;
		writes = [];
		const code = error instanceof ApiError ? error.code : "internal_error";
		step.error = code;
		if (
			![
				"repository_cooldown",
				"github_unauthorized",
				"encryption_key_missing",
				"github_rate_limited",
				"factory_capacity",
				"factory_yield",
				"worker_interrupted",
			].includes(code)
		)
			step.retryFailures = (step.retryFailures ?? 0) + 1;
		if (code === "factory_yield") {
			step.status = "pending";
			step.error = null;
			run.nextAttemptAt = clock();
			stop = true;
		} else if (code === "repository_cooldown") {
			for (const later of run.steps)
				if (
					later.repo === step.repo &&
					later.kind !== "snapshot" &&
					(later.status === "pending" || later.status === "running")
				) {
					finish(later, "skipped", clock());
					later.error = code;
					later.attempts = 0;
				}
			run.nextAttemptAt = clock();
		} else if (
			code === "github_unauthorized" ||
			code === "encryption_key_missing" ||
			code === "factory_capacity"
		) {
			run.status = "paused";
			step.status = "pending";
		} else if (code === "github_rate_limited") {
			invocation.stopped = true;
			step.status = "pending";
			run.nextAttemptAt = new Date(
				Math.max(
					Date.parse(error instanceof ApiError && error.retryAt ? error.retryAt : "") || 0,
					Date.parse(run.checkpoint?.rate?.resetAt ?? "") || 0,
					Date.parse(clock()) + 900_000,
				),
			).toISOString();
		} else if (
			(step.retryFailures ?? 0) <= RUN_MAX_RETRIES &&
			code !== "repository_unavailable" &&
			![
				"snapshot_incomplete",
				"snapshot_sources_incomplete",
				"snapshot_unavailable",
				"catalog_changed",
				"capability_missing",
				"github_forbidden",
				"not_found",
			].includes(code) &&
			code !== "github_response_too_large"
		) {
			step.status = "pending";
			run.nextAttemptAt = new Date(
				Date.parse(clock()) + retryDelay(step.retryFailures ?? 1) * 1000,
			).toISOString();
		} else {
			const unavailable = [
				"capability_missing",
				"snapshot_unavailable",
				"github_forbidden",
				"not_found",
			].includes(code);
			finish(step, unavailable ? "unavailable" : "failed", clock());
			if (step.kind === "contributions" && run.checkpoint)
				run.checkpoint.contributionStatus = "unavailable";
			if (step.kind === "snapshot") {
				run.nextAttemptAt = clock();
			} else if (step.repo) {
				for (const later of run.steps)
					if (later.repo === step.repo && later.kind !== "snapshot" && later.status === "pending") {
						finish(later, "skipped", clock());
						later.error = "repository_failed";
						if (unavailable) {
							later.status = "unavailable";
							later.error = code;
						}
					}
				writes = await repositoryWrites(db, lease, clock(), null, step.repo, code);
			} else if (step.kind !== "contributions") {
				run.status = "failed";
				run.finishedAt = clock();
				for (const later of run.steps)
					if (later.status === "pending") {
						finish(later, "skipped", clock());
						later.error = "run_failed";
					}
			}
		}
	}
	step.durationMs += Math.max(0, Date.parse(clock()) - Date.parse(started));
	run.requests += gh.count;
	while (
		run.steps[run.cursor] &&
		!["pending", "running"].includes(run.steps[run.cursor]?.status ?? "")
	)
		run.cursor++;
	return { writes, stop };
}
function finish(
	step: FactoryRunStep,
	status: "success" | "failed" | "skipped" | "unavailable" | "limited",
	now: string,
) {
	step.status = status;
	step.finishedAt = now;
}
