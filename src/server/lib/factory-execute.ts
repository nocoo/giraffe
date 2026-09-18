import { type FactoryRunStep, RUN_MAX_RETRIES, retryDelay } from "../../lib/factory-run";
import {
	FACTORY_STREAMS,
	type FactoryStreamData,
	type FactoryStreamName,
} from "../../lib/factory-types";
import { type Env, encryptionKey } from "../env";
import { getAccount } from "./db/accounts";
import { createDb } from "./db/d1";
import { claimRun, fenced, saveRun } from "./db/factory-runs";
import { ApiError } from "./errors";
import { newFactory, stepFactory } from "./factory-collect";
import { exclusion, mapFactoryRepo, object } from "./factory-map";
import {
	boundedJson,
	publicationWrites,
	repositoryWrites,
	restoreLegacyRepo,
} from "./factory-publish";
import { FACTORY_REPO_QUERY } from "./factory-queries";
import { checkFactoryCapacity, resourceDelta } from "./factory-retention";
import { collectSitePage } from "./factory-site";
import { createGithubClient } from "./github-client";
import { assertRefreshCapabilities } from "./refresh";
import { decryptToken, parseKeyBytes } from "./token-crypto";

export async function executeRunPage(
	env: Env,
	id: string,
	clock = () => new Date().toISOString(),
): Promise<string | null> {
	const db = createDb(env.DB);
	const lease = await claimRun(db, id, clock());
	if (!lease) return null;
	const run = lease.run;
	while (
		run.steps[run.cursor] &&
		!["pending", "running"].includes(run.steps[run.cursor]?.status ?? "")
	)
		run.cursor++;
	const step = run.steps[run.cursor];
	if (!step) {
		run.status = run.steps.some((s) => s.status === "failed" || s.status === "skipped")
			? "partial"
			: "completed";
		run.finishedAt = clock();
		await saveRun(db, lease, [], clock());
		return null;
	}
	const started = clock();
	const savedPages = step.pages;
	const savedSnapshotCursor = step.snapshotCursor;
	step.startedAt ??= started;
	step.attempts = step.error ? step.attempts + 1 : Math.max(1, step.attempts);
	step.status = "running";
	step.error = null;
	const began = await fenced(
		db,
		lease,
		clock(),
		"UPDATE factory_runs SET payload=? WHERE id=? AND $guard",
		[JSON.stringify(run), run.id],
	).run();
	if (!began.meta.changes) return null;
	const before = structuredClone(run.checkpoint);
	const gh = createGithubClient(env, undefined, 4_000_000);
	let writes: D1PreparedStatement[] = [];
	try {
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
				previousAttempt.nextAllowedAt > clock() &&
				previousAttempt.attemptRunId !== run.id
			)
				throw new ApiError(409, "repository_cooldown", "repository cooldown");
		}
		let token = "";
		if (!["restore", "commit", "publish"].includes(step.kind)) {
			const account = await getAccount(db, run.account_id);
			if (!account) throw new ApiError(409, "account_missing", "account missing");
			if (step.kind === "snapshot")
				assertRefreshCapabilities(account.capabilities, [step.resource ?? ""]);
			const key = encryptionKey(env, account.key_version);
			if (!key) throw new ApiError(500, "encryption_key_missing", "encryption key missing");
			token = await decryptToken(account.token_ciphertext, parseKeyBytes(key));
		}
		if (step.kind === "snapshot") {
			const result = await collectSitePage(db, lease, step, gh, token, clock());
			writes = result.writes;
			if (result.done) finish(step, "success", clock());
		} else if (step.kind === "metadata") {
			const [owner, name] = String(step.repo).split("/");
			const data = await gh.githubGraphql(token, FACTORY_REPO_QUERY, { owner, name });
			const repo = object(data.repository);
			if (
				gh.graphqlErrors.length ||
				exclusion(repo, run.owner) ||
				repo.id !== run.repoIds[String(step.repo)]
			)
				throw new ApiError(403, "repository_unavailable", "repository identity/access changed");
			const previous = run.checkpoint;
			run.checkpoint = newFactory(run.account_id, run.owner, run.startedAt);
			run.checkpoint.runId = run.id;
			run.checkpoint.inventory.complete = true;
			run.checkpoint.repos = [{ ...mapFactoryRepo(repo), metadataAt: clock() }];
			run.checkpoint.contributionStatus = previous?.contributionStatus ?? "unavailable";
			run.checkpoint.contribution = previous?.contribution ?? null;
			const rate = object(data.rateLimit);
			if (typeof rate.remaining === "number")
				run.checkpoint.rate = {
					remaining: rate.remaining,
					resetAt: typeof rate.resetAt === "string" ? rate.resetAt : null,
					resource: "graphql",
				};
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
			writes = await publicationWrites(db, lease, clock());
			finish(step, "success", clock());
			run.status = run.steps.some((s) => s.status === "failed" || s.status === "skipped")
				? "partial"
				: "completed";
			run.finishedAt = clock();
		} else {
			run.checkpoint ??= newFactory(run.account_id, run.owner, run.startedAt);
			const checkpoint = run.checkpoint;
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
				read: async () => {
					const row = await db
						.prepare("SELECT payload FROM factory_resources WHERE run_id=? AND repo=? AND stream=?")
						.bind(run.id, step.repo, stream)
						.first<{ payload: string }>();
					return row ? (JSON.parse(row.payload) as FactoryStreamData) : null;
				},
				write: async (_key: string, data: FactoryStreamData) => {
					lease.extraBytes =
						(lease.extraBytes ?? 0) +
						(await resourceDelta(db, run.id, String(step.repo), String(stream), boundedJson(data)));
					writes.push(
						fenced(
							db,
							lease,
							clock(),
							"INSERT INTO factory_resources(run_id,repo,stream,payload) SELECT ?,?,?,? WHERE $guard ON CONFLICT(run_id,repo,stream) DO UPDATE SET payload=excluded.payload",
							[run.id, step.repo, stream, boundedJson(data)],
						),
					);
				},
			};
			await stepFactory(checkpoint, gh, token, store, clock());
			if (step.kind === "inventory") {
				if (checkpoint.repos.length > 500)
					throw new ApiError(422, "factory_capacity", "catalog exceeds 500 repositories");
				if (checkpoint.inventory.complete) finish(step, "success", clock());
			} else if (step.kind === "contributions")
				finish(step, checkpoint.contributionStatus === "complete" ? "success" : "failed", clock());
			else if (stream) {
				const coverage = checkpoint.repos[0]?.coverage[stream];
				if (coverage && coverage.status !== "partial") {
					finish(step, coverage.status === "complete" ? "success" : "failed", clock());
					if (coverage.status !== "complete") step.error = `coverage_${coverage.status}`;
				}
			}
		}
		step.pages += gh.count;
		step.retryFailures = 0;
		await checkFactoryCapacity(
			db,
			run.account_id,
			(lease.extraBytes ?? 0) +
				new TextEncoder().encode(boundedJson(run)).length -
				(lease.storedBytes ?? 0),
		);
		run.nextAttemptAt = clock();
	} catch (error) {
		run.checkpoint = before;
		step.pages = savedPages;
		if (savedSnapshotCursor === undefined) delete step.snapshotCursor;
		else step.snapshotCursor = savedSnapshotCursor;
		step.finishedAt = null;
		writes = [];
		lease.extraBytes = 0;
		const code = error instanceof ApiError ? error.code : "internal_error";
		step.error = code;
		if (
			![
				"repository_cooldown",
				"github_unauthorized",
				"encryption_key_missing",
				"github_rate_limited",
				"factory_capacity",
			].includes(code)
		)
			step.retryFailures = (step.retryFailures ?? 0) + 1;
		if (code === "repository_cooldown") {
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
			code !== "factory_capacity" &&
			code !== "repository_unavailable" &&
			![
				"snapshot_incomplete",
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
			finish(step, "failed", clock());
			if (step.kind === "snapshot") {
				// A page failure must not invalidate factory metrics or other page sources.
				run.nextAttemptAt = clock();
			} else if (step.repo) {
				for (const later of run.steps)
					if (later.repo === step.repo && later.kind !== "snapshot" && later.status === "pending") {
						finish(later, "skipped", clock());
						later.error = "repository_failed";
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
	const saved = await saveRun(db, lease, writes, clock());
	return saved && run.status === "running" ? run.nextAttemptAt : null;
}
function finish(step: FactoryRunStep, status: "success" | "failed" | "skipped", now: string) {
	step.status = status;
	step.finishedAt = now;
}
