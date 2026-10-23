import { expect, it } from "vitest";
import { NOW, ready } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { FACTORY_REPO_CONCURRENCY, makeRun } from "../../lib/factory-run";
import type { FactoryStreamData } from "../../lib/factory-types";
import type { Env } from "../env";
import { MAX_STAGED_BYTES } from "./collect";
import { createDb } from "./db/d1";
import { claimRun, fenced, getRun, saveRun, startRun } from "./db/factory-runs";
import { collectActionsSnapshot, stepActions } from "./factory-actions";
import {
	FactoryInvocation,
	INVOCATION_DB_STATEMENTS,
	INVOCATION_REQUESTS,
	InvocationStopped,
} from "./factory-invocation";
import { executeRepoPool, poolSteps } from "./factory-pool";
import { createGithubClient } from "./github-client";

const BASELINE = "actions-budget-baseline";
const BASELINE_AT = "2026-09-14T22:00:00.000Z";
const SINCE = "2026-08-15T00:00:00.000Z";
const HISTORY_COUNT = 3998;

function workflow(id: number, createdAt = "2020-01-01T00:00:00.000Z", name = "Deploy") {
	return {
		id,
		name,
		created_at: createdAt,
		run_started_at: createdAt,
		status: "completed",
		conclusion: "success",
	};
}

async function resource(
	raw: D1Database,
	runId: string,
	repo: string,
	stream: string,
	payload: unknown,
) {
	await raw
		.prepare("INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,?,?,?)")
		.bind(runId, repo, stream, JSON.stringify(payload))
		.run();
}

it("resumes four large Actions materializations near 500 statements without losing accepted pages", async () => {
	const raw = sqliteFixture();
	const seed = createDb(raw);
	await seed
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('account','nocoo','fake','fake',?,?)",
		)
		.bind(NOW, NOW)
		.run();
	const template = ready("actions");
	const original = template.repos[0];
	if (!original) throw new Error("fixture repository missing");
	const repos = Array.from({ length: FACTORY_REPO_CONCURRENCY }, (_, index) => ({
		...structuredClone(original),
		id: `budget-repo-${index}`,
		name: `nocoo/budget-${index}`,
	}));
	const run = makeRun(
		"actions-budget",
		"account",
		"nocoo",
		"actions-budget",
		"refresh",
		repos,
		NOW,
		[],
		repos.map((repo) => repo.name),
		{ scope: "selected" },
	);
	run.steps = run.steps.filter((step) => step.kind === "actions");
	for (const step of run.steps) step.pages = 2;
	await startRun(seed, run);
	await seed
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,'account','baseline','completed','{}',?,?,?)",
		)
		.bind(BASELINE, BASELINE_AT, BASELINE_AT, BASELINE_AT)
		.run();
	const history = Array.from({ length: HISTORY_COUNT }, (_, index) =>
		workflow(index + 1, undefined, "x".repeat(3700)),
	);
	const firstDelta = workflow(3999, "2026-09-15T21:00:00.000Z");
	const finalDelta = workflow(4000, "2026-09-15T20:00:00.000Z");
	for (const repo of repos) {
		const deltaNext = `/repos/${repo.name}/actions/runs?created=>=${SINCE}&per_page=100&page=2`;
		const acceptedDelta = JSON.stringify({ runs: [firstDelta], next: deltaNext });
		let bytes = 0;
		for (let index = 0; index < 40; index++) {
			const page = JSON.stringify({
				runs: history.slice(index * 100, (index + 1) * 100),
				next: index < 39 ? `/repos/${repo.name}/actions/runs?per_page=100&page=${index + 2}` : null,
			});
			bytes += new TextEncoder().encode(page).length;
			for (let offset = 0; offset < page.length; offset += 250_000)
				await resource(
					raw,
					BASELINE,
					repo.name,
					`actions-source:${String(index).padStart(3, "0")}:${String(offset / 250_000).padStart(3, "0")}`,
					page.slice(offset, offset + 250_000),
				);
		}
		expect(bytes).toBeLessThan(MAX_STAGED_BYTES);
		await resource(raw, run.id, repo.name, "actions-source", {
			status: "partial",
			next: `/repos/${repo.name}/actions/runs?per_page=100`,
			pages: 0,
			observed: 0,
			expected: 0,
			bytes: 0,
			incremental: {
				runId: BASELINE,
				baselinePages: 40,
				since: SINCE,
				retained: HISTORY_COUNT,
				total: 4000,
				next: deltaNext,
				pages: 1,
				observed: 1,
				expected: 2,
				bytes: new TextEncoder().encode(acceptedDelta).length,
			},
		});
		await resource(raw, run.id, repo.name, "actions-incremental:000:000", acceptedDelta);
		const checkpoint = structuredClone(template);
		checkpoint.account_id = run.account_id;
		checkpoint.runId = run.id;
		checkpoint.repos = [repo];
		repo.coverage.actions.status = "partial";
		await resource(raw, run.id, repo.name, "executor:checkpoint", checkpoint);
	}
	const requests: string[] = [];
	const statementCounts: number[] = [];
	async function invoke(warm: boolean) {
		const db = createDb(raw, undefined, INVOCATION_DB_STATEMENTS);
		const lease = await claimRun(db, run.id, NOW);
		if (!lease) throw new Error("fixture lease missing");
		if (warm) {
			await db.batch(Array.from({ length: 500 - db.statements }, () => db.prepare("SELECT 1")));
			expect(db.statements).toBe(500);
		}
		const invocation = new FactoryInvocation(db, lease, () => NOW);
		const firstWave = new Set<string>();
		let release = () => {};
		const materialized = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			await executeRepoPool(
				db,
				lease,
				invocation,
				poolSteps(lease.run),
				async (stepDb, lane, step, hooks) => {
					step.status = "running";
					step.attempts = Math.max(1, step.attempts);
					step.startedAt ??= NOW;
					expect(await hooks.begin(step)).toBe(true);
					const checkpoint = lane.run.checkpoint;
					if (!checkpoint || !step.repo) throw new Error("fixture checkpoint missing");
					const before = structuredClone(checkpoint);
					const repo = step.repo;
					const client = createGithubClient(
						{ ENVIRONMENT: "development", GITHUB_API_BASE: "http://fixture" } as Env,
						async (input) => {
							const url = new URL(String(input));
							expect(url.origin).toBe("http://fixture");
							expect(url.pathname).toBe(`/repos/${repo}/actions/runs`);
							expect(url.searchParams.get("created")).toBe(`>=${SINCE}`);
							expect(url.searchParams.get("page")).toBe("2");
							requests.push(repo);
							return Response.json({ total_count: 2, workflow_runs: [finalDelta] });
						},
						undefined,
						() => invocation.beforeRequest(hooks.heartbeat),
					);
					const writes: D1PreparedStatement[] = [];
					let data: FactoryStreamData | undefined;
					try {
						writes.push(
							...(await stepActions(
								stepDb,
								lane,
								checkpoint,
								client,
								"fake",
								{
									read: async () => {
										const row = await stepDb
											.prepare(
												"SELECT payload FROM factory_resources WHERE run_id=? AND repo=? AND stream='actions'",
											)
											.bind(run.id, repo)
											.first<{ payload: string }>();
										return row ? (JSON.parse(row.payload) as FactoryStreamData) : null;
									},
									write: async (_key, value) => {
										data = value;
										writes.push(
											fenced(
												stepDb,
												lane,
												NOW,
												"INSERT INTO factory_resources(run_id,repo,stream,payload) SELECT ?,?,'actions',? WHERE $guard ON CONFLICT(run_id,repo,stream) DO UPDATE SET payload=excluded.payload",
												[run.id, repo, JSON.stringify(value)],
											),
										);
									},
								},
								NOW,
							)),
						);
						if (checkpoint.repos[0]?.coverage.actions.status === "complete") {
							step.status = "success";
							step.finishedAt = NOW;
						}
						step.pages += client.count;
						lane.run.requests += client.count;
						if (data) expect(data.coverage.status).not.toBe("limited");
						return { writes, stop: false };
					} catch (error) {
						if (!(error instanceof InvocationStopped) || error.lostLease) throw error;
						lane.run.checkpoint = before;
						step.status = "pending";
						return { writes: [], stop: true };
					} finally {
						if (warm && !firstWave.has(repo)) {
							firstWave.add(repo);
							if (firstWave.size === FACTORY_REPO_CONCURRENCY) release();
							await materialized;
						}
					}
				},
				() => {},
				() => {},
			);
			if (lease.run.steps.every((step) => step.status === "success")) {
				lease.run.status = "completed";
				lease.run.finishedAt = NOW;
			}
			expect(await saveRun(db, lease, [], NOW)).toBe(true);
			expect(invocation.requests).toBeLessThanOrEqual(INVOCATION_REQUESTS);
		} finally {
			statementCounts.push(db.statements);
			expect(db.statements).toBeLessThanOrEqual(INVOCATION_DB_STATEMENTS);
		}
	}
	await expect(invoke(true)).resolves.toBeUndefined();
	expect(requests).toHaveLength(FACTORY_REPO_CONCURRENCY);
	const accepted = await raw
		.prepare(
			"SELECT repo,stream,payload FROM factory_resources WHERE run_id=? AND (stream LIKE 'actions-source:%' OR stream LIKE 'actions-materializing:%') ORDER BY repo,stream",
		)
		.bind(run.id)
		.all<{ repo: string; stream: string; payload: string }>();
	expect(accepted.results.length).toBeGreaterThan(0);
	let completed = (await getRun(createDb(raw), run.account_id, run.id))?.run;
	for (let attempt = 0; completed?.status === "running" && attempt < 30; attempt++) {
		await expect(invoke(false)).resolves.toBeUndefined();
		completed = (await getRun(createDb(raw), run.account_id, run.id))?.run;
	}
	expect(completed?.status).toBe("completed");
	expect(completed?.steps).toMatchObject(
		Array.from({ length: FACTORY_REPO_CONCURRENCY }, () => ({
			status: "success",
			pages: 3,
			attempts: 1,
			error: null,
		})),
	);
	expect(statementCounts.length).toBeGreaterThan(1);
	for (const row of accepted.results)
		expect(
			await raw
				.prepare("SELECT payload FROM factory_resources WHERE run_id=? AND repo=? AND stream=?")
				.bind(run.id, row.repo, row.stream.replace(/^actions-materializing:/, "actions-source:"))
				.first(),
		).toEqual({ payload: row.payload });
	const lease = { run: completed ?? run, token: "read-only", version: 0, leaseUntil: NOW };
	const unused = createGithubClient(
		{ ENVIRONMENT: "development", GITHUB_API_BASE: "http://fixture" } as Env,
		async () => {
			throw new Error("accepted Actions pages must not be fetched again");
		},
	);
	for (const repo of repos) {
		const result = await collectActionsSnapshot(
			createDb(raw),
			lease,
			repo.name,
			unused,
			"fake",
			NOW,
		);
		expect(result.payload?.truncated).toBe(false);
		if (!result.payload) throw new Error("complete Actions snapshot missing");
		expect((result.payload.runs as { id: number }[]).map((entry) => entry.id)).toEqual([
			3999,
			4000,
			...history.map((entry) => entry.id),
		]);
		expect(requests.filter((name) => name === repo.name)).toHaveLength(1);
	}
}, 30_000);
