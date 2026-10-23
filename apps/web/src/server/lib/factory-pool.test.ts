import { afterEach, expect, it, vi } from "vitest";
import { rawRepo } from "../../../../../tests/fixtures/factory";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { FACTORY_REPO_CONCURRENCY, makeRun, RUN_LEASE_MS } from "../../lib/factory-run";
import type { Env } from "../env";
import { createDb } from "./db/d1";
import { dueRuns, getRun, publishedFactory, startRun } from "./db/factory-runs";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { consumeFactory, continueFactory } from "./factory-dispatch";
import { executeRunPage } from "./factory-execute";
import { FactoryInvocation, InvocationStopped } from "./factory-invocation";
import { encryptToken, parseKeyBytes } from "./token-crypto";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function setup(activity = false, metadataRequests = 4) {
	const snapshot = factoryFixture();
	const first = snapshot.repos[0];
	if (!first) throw new Error("fixture");
	const repos = Array.from({ length: 4 }, (_, index) => ({
		...structuredClone(first),
		id: `repo-${index}`,
		name: `nocoo/app${index}`,
	}));
	const now = snapshot.fetched_at;
	const env = {
		DB: sqliteFixture(),
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
		TOKEN_ENCRYPTION_KEY_V1: "0".repeat(64),
	} as unknown as Env;
	const db = createDb(env.DB);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at,capabilities) VALUES(?,?,?,?,?,?,?)",
		)
		.bind(
			snapshot.account_id,
			"nocoo",
			await encryptToken("fake", parseKeyBytes("0".repeat(64))),
			"fake",
			now,
			now,
			JSON.stringify({ repo: true, notifications: true }),
		)
		.run();
	await db.batch(
		await replaceSnapshotStmts(db, snapshot.account_id, "factory", { ...snapshot, repos }, now),
	);
	await db.batch(
		await replaceSnapshotStmts(
			db,
			snapshot.account_id,
			"repos",
			{ repos: repos.map((repo) => ({ name_with_owner: repo.name })) },
			now,
		),
	);
	const run = makeRun(
		"pool",
		snapshot.account_id,
		"nocoo",
		"pool",
		"refresh",
		repos,
		now,
		[],
		repos.map((repo) => repo.name),
		{ scope: "selected", repos: repos.map((repo) => repo.name) },
		activity ? "quick" : "deep",
	);
	if (activity) {
		run.trigger = "daily";
		const template = run.steps[0];
		if (!template) throw new Error("fixture");
		run.steps.splice(
			run.steps.length - 1,
			0,
			...repos.map((repo) => ({ ...template, repo: repo.name, kind: "activity" as const })),
		);
	}
	await startRun(db, run);
	let active = 0;
	let peak = 0;
	let requests = 0;
	let release = () => {};
	const firstBatch = new Promise<void>((resolve) => {
		release = resolve;
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			active++;
			peak = Math.max(peak, active);
			if (++requests <= metadataRequests) {
				if (requests === metadataRequests) release();
				await firstBatch;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
			active--;
			const body = init?.body ? JSON.parse(String(init.body)) : {};
			const query = String(body.query);
			if (query.includes("search(query"))
				return Response.json({
					data: { search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } } },
				});
			if (query.includes("nameWithOwner")) {
				const name = String(body.variables?.name ?? "app0");
				return Response.json({
					data: {
						repository: {
							...rawRepo,
							id: `repo-${name.slice(-1)}`,
							name,
							nameWithOwner: `nocoo/${name}`,
						},
					},
				});
			}
			if (query.includes("object(expression")) return Response.json({ data: { repository: {} } });
			if (query.includes("vulnerabilityAlerts"))
				return Response.json({
					data: {
						repository: { vulnerabilityAlerts: { nodes: [], pageInfo: { hasNextPage: false } } },
					},
				});
			return Response.json(
				url.includes("actions/runs") ? { total_count: 0, workflow_runs: [] } : [],
			);
		}),
	);
	const read = async () => {
		const found = await getRun(createDb(env.DB), run.account_id, run.id);
		if (!found) throw new Error("fixture");
		return found.run;
	};
	return { env, run, now, read, peak: () => peak };
}

it("overlaps four repositories while keeping publication and budgets bounded", async () => {
	const fixture = await setup();
	await executeRunPage(fixture.env, fixture.run.id, () => fixture.now);
	expect(fixture.peak()).toBe(FACTORY_REPO_CONCURRENCY);
	let run = await fixture.read();
	expect(
		run.steps.filter((step) => step.kind === "metadata" && step.status === "success"),
	).toHaveLength(4);
	expect(run.requests).toBeLessThanOrEqual(40);
	for (let attempt = 0; run.status === "running" && attempt < 100; attempt++) {
		await executeRunPage(fixture.env, run.id, () => run.nextAttemptAt);
		run = await fixture.read();
	}
	expect(run.steps.filter((step) => step.status !== "success")).toEqual([]);
	expect(run.status).toBe("completed");
	expect(run.steps.every((step) => step.status === "success")).toBe(true);
	expect((await publishedFactory(createDb(fixture.env.DB), run.account_id))?.repos).toHaveLength(4);
});

it("retains accepted steps when a pool dies and retries at most one step per repository", async () => {
	const fixture = await setup();
	const beforeRequest = FactoryInvocation.prototype.beforeRequest;
	let calls = 0;
	vi.spyOn(FactoryInvocation.prototype, "beforeRequest").mockImplementation(async function (
		this: FactoryInvocation,
		...args
	) {
		if (++calls === 8) throw new InvocationStopped(true);
		return beforeRequest.apply(this, args);
	});
	expect(await executeRunPage(fixture.env, fixture.run.id, () => fixture.now)).toBe(fixture.now);
	let run = await fixture.read();
	const accepted = run.steps.filter((step) => step.status === "success");
	expect(
		new Set(accepted.filter((step) => step.kind === "metadata").map((step) => step.repo)).size,
	).toBe(4);
	for (const repo of run.repos)
		expect(
			run.steps.filter((step) => step.repo === repo && step.status === "running"),
		).toHaveLength(1);
	vi.restoreAllMocks();
	const resumedAt = new Date(Date.parse(fixture.now) + 5_000).toISOString();
	for (let attempt = 0; run.status === "running" && attempt < 100; attempt++) {
		await executeRunPage(fixture.env, run.id, () =>
			run.nextAttemptAt > resumedAt ? run.nextAttemptAt : resumedAt,
		);
		run = await fixture.read();
	}
	expect(run.status).toBe("completed");
	expect(run.steps.filter((step) => step.status !== "success")).toEqual([]);
	for (const step of accepted)
		expect(
			run.steps.find(
				(candidate) =>
					candidate.repo === step.repo &&
					candidate.kind === step.kind &&
					candidate.resource === step.resource,
			),
		).toEqual(step);
	for (const repo of run.repos) {
		const retried = run.steps.filter((step) => step.repo === repo && step.attempts > 1);
		expect(retried).toHaveLength(1);
		expect(retried[0]).toMatchObject({
			attempts: 2,
			retryFailures: 0,
			error: null,
			status: "success",
		});
	}
	expect((await publishedFactory(createDb(fixture.env.DB), run.account_id))?.repos).toHaveLength(4);
});

it("takes over an expired pool and fences every late result from its old lease", async () => {
	const fixture = await setup();
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	let held = 0;
	let ready = () => {};
	let release = () => {};
	const allHeld = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const responseGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let hold = true;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			if (hold && url.includes("/commits?")) {
				if (++held === 4) ready();
				await responseGate;
			}
			return base(url, init);
		}),
	);
	let time = fixture.now;
	const old = executeRunPage(fixture.env, fixture.run.id, () => time);
	await allHeld;
	const interrupted = await fixture.read();
	const accepted = interrupted.steps.filter((step) => step.status === "success");
	expect(accepted).toHaveLength(4);
	for (const repo of interrupted.repos)
		expect(
			interrupted.steps.filter((step) => step.repo === repo && step.status === "running"),
		).toHaveLength(1);
	time = new Date(Date.parse(time) + RUN_LEASE_MS).toISOString();
	hold = false;
	await executeRunPage(fixture.env, fixture.run.id, () => time);
	const replacement = await fixture.read();
	expect(
		replacement.steps
			.filter((step) => step.kind === "commits")
			.every(
				(step) => step.status === "success" && step.attempts === 2 && step.finishedAt === time,
			),
	).toBe(true);
	release();
	await old;
	expect(await fixture.read()).toEqual(replacement);
	let run = replacement;
	for (let attempt = 0; run.status === "running" && attempt < 100; attempt++) {
		await executeRunPage(fixture.env, run.id, () =>
			run.nextAttemptAt > time ? run.nextAttemptAt : time,
		);
		run = await fixture.read();
	}
	expect(run.status).toBe("completed");
	for (const step of accepted)
		expect(
			run.steps.find((candidate) => candidate.repo === step.repo && candidate.kind === step.kind),
		).toEqual(step);
	expect(run.steps.filter((step) => step.attempts > 1)).toHaveLength(4);
	expect((await publishedFactory(createDb(fixture.env.DB), run.account_id))?.repos).toHaveLength(4);
});

it.each(["redelivery", "cron"] as const)(
	"recovers canceled consecutive pool snapshots through %s without catch or release",
	async (recovery) => {
		const fixture = await setup();
		const db = createDb(fixture.env.DB);
		const base = vi.mocked(fetch).getMockImplementation();
		if (!base) throw new Error("fixture");
		vi.useFakeTimers({ toFake: ["Date"] });
		const canceledAt = Date.parse(fixture.now) + 80_001;
		vi.setSystemTime(canceledAt);
		const queued: { id: string; at: number }[] = [];
		const send = vi.fn(async (body: { id: string }, options?: { delaySeconds?: number }) => {
			queued.push({ id: body.id, at: Date.now() + (options?.delaySeconds ?? 0) * 1000 });
		});
		fixture.env.FACTORY_QUEUE = { send } as unknown as Env["FACTORY_QUEUE"];
		const consume = () => {
			const message = { body: { id: fixture.run.id }, attempts: 1, ack: vi.fn(), retry: vi.fn() };
			const pending = consumeFactory(
				{ messages: [message] } as unknown as MessageBatch<unknown>,
				fixture.env,
			);
			return { message, pending };
		};
		let held = 0;
		let ready = () => {};
		let release = () => {};
		const allHeld = new Promise<"canceled">((resolve) => {
			ready = () => resolve("canceled");
		});
		const abandonedResponses = new Promise<void>((resolve) => {
			release = resolve;
		});
		let hold = true;
		const requested: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				requested.push(url);
				if (url.endsWith("/traffic/clones")) {
					if (hold) {
						if (++held === FACTORY_REPO_CONCURRENCY) ready();
						await abandonedResponses;
					}
					return Response.json({ count: 3, uniques: 2, clones: [] });
				}
				if (url.endsWith("/traffic/views"))
					return Response.json({ count: 17, uniques: 11, views: [] });
				if (/\/repos\/nocoo\/app\d$/.test(url))
					return Response.json({ full_name: url.split("/repos/")[1], description: "accepted" });
				return base(url, init);
			}),
		);
		let abandoned: ReturnType<typeof consume> | undefined;
		try {
			for (let invocation = 0; invocation < 30; invocation++) {
				const before = await fixture.read();
				const current = consume();
				if (
					(await Promise.race([current.pending.then(() => "finished"), allHeld])) === "canceled"
				) {
					abandoned = current;
					expect(
						before.steps.filter((step) => step.kind === "snapshot" && step.status === "success"),
					).toEqual([]);
					break;
				}
				expect(current.message.retry).not.toHaveBeenCalled();
				queued.length = 0;
			}
			expect(abandoned).toBeDefined();
			if (!abandoned) throw new Error("snapshot pool did not suspend");
			const logged = vi.spyOn(console, "log").mockImplementation(() => {});
			const interrupted = await fixture.read();
			const accepted = interrupted.steps.filter((step) => step.status === "success");
			const inFlight = interrupted.steps.filter((step) => step.status === "running");
			expect(inFlight).toHaveLength(FACTORY_REPO_CONCURRENCY);
			const snapshots = new Map<string, Record<string, unknown>>();
			for (const repo of interrupted.repos) {
				const consecutive = interrupted.steps.filter(
					(step) => step.repo === repo && step.kind === "snapshot",
				);
				expect(consecutive.slice(0, 3)).toMatchObject([
					{ resource: `repo:${repo}:details`, status: "success", attempts: 1 },
					{ resource: `repo:${repo}:actions`, status: "success", attempts: 1 },
					{
						resource: `repo:${repo}:traffic`,
						status: "running",
						attempts: 1,
						retryFailures: 0,
						error: null,
					},
				]);
				expect(inFlight.filter((step) => step.repo === repo)).toHaveLength(1);
				for (const tab of ["details", "actions"]) {
					const resource = `repo:${repo}:${tab}`;
					const snapshot = await readSnapshot(db, interrupted.account_id, resource, interrupted.id);
					expect(snapshot).not.toBeNull();
					if (!snapshot) throw new Error("missing accepted snapshot");
					snapshots.set(resource, snapshot);
				}
			}
			const replayPages = () =>
				db
					.prepare(
						"SELECT stream,payload FROM factory_resources WHERE run_id=? AND stream LIKE 'snapshot-replay:%' ORDER BY stream",
					)
					.bind(interrupted.id)
					.all<{ stream: string; payload: string }>();
			const pages = await replayPages();
			expect(pages.results).toHaveLength(4);
			const ownership = () =>
				db
					.prepare("SELECT lease_token,lease_until,version FROM factory_runs WHERE id=?")
					.bind(interrupted.id)
					.first<{ lease_token: string; lease_until: string; version: number }>();
			const lease = await ownership();
			expect(lease?.lease_until).toBe(new Date(canceledAt + 40_000).toISOString());
			expect(await dueRuns(db, new Date(canceledAt + RUN_LEASE_MS - 1).toISOString())).toEqual([]);
			expect(logged).not.toHaveBeenCalled();
			if (recovery === "redelivery") {
				vi.setSystemTime(canceledAt + 39_001);
				const duplicate = consume();
				await duplicate.pending;
				expect(duplicate.message.ack).toHaveBeenCalledOnce();
				expect(duplicate.message.retry).not.toHaveBeenCalled();
				expect(send).toHaveBeenLastCalledWith({ id: interrupted.id }, { delaySeconds: 1 });
			} else {
				vi.setSystemTime(Math.floor((canceledAt + RUN_LEASE_MS) / 60_000) * 60_000);
				await continueFactory(fixture.env, Date.now());
				expect(queued).toEqual([]);
			}
			expect(await ownership()).toEqual(lease);
			expect(await fixture.read()).toEqual(interrupted);
			expect((await replayPages()).results).toEqual(pages.results);
			expect(await dueRuns(db, new Date(canceledAt + RUN_LEASE_MS).toISOString())).toEqual([
				interrupted.id,
			]);
			if (recovery === "cron") {
				vi.setSystemTime(Date.now() + 60_000);
				await continueFactory(fixture.env, Date.now());
			}
			expect(queued).toHaveLength(1);
			const next = queued.shift();
			if (!next) throw new Error("missing durable continuation");
			expect(next.id).toBe(interrupted.id);
			vi.setSystemTime(next.at);
			const takeoverMs = Date.now() - canceledAt;
			expect(takeoverMs).toBe(recovery === "redelivery" ? 40_001 : 99_999);
			expect(takeoverMs).toBeLessThan(recovery === "redelivery" ? 41_000 : RUN_LEASE_MS + 60_000);
			expect(abandoned.message.ack).not.toHaveBeenCalled();
			expect(abandoned.message.retry).not.toHaveBeenCalled();
			hold = false;
			let run = interrupted;
			for (let invocation = 0; run.status === "running" && invocation < 100; invocation++) {
				const replacement = consume();
				await replacement.pending;
				expect(replacement.message.ack).toHaveBeenCalledOnce();
				expect(replacement.message.retry).not.toHaveBeenCalled();
				run = await fixture.read();
				const continuation = queued.shift();
				if (continuation) vi.setSystemTime(continuation.at);
			}
			expect(run.status).toBe("completed");
			expect(run.steps.every((step) => step.status === "success")).toBe(true);
			for (const step of accepted)
				expect(
					run.steps.find(
						(candidate) =>
							candidate.repo === step.repo &&
							candidate.kind === step.kind &&
							candidate.resource === step.resource,
					),
				).toEqual(step);
			expect(run.steps.filter((step) => step.attempts > 1)).toHaveLength(4);
			for (const repo of run.repos) {
				expect(run.steps.filter((step) => step.repo === repo && step.attempts > 1)).toMatchObject([
					{
						resource: `repo:${repo}:traffic`,
						attempts: 2,
						retryFailures: 0,
						error: null,
						status: "success",
						finishedAt: new Date(next.at).toISOString(),
					},
				]);
				const traffic = await readSnapshot(db, run.account_id, `repo:${repo}:traffic`);
				expect(traffic).toMatchObject({
					views: { count: 17, uniques: 11 },
					clones: { count: 3, uniques: 2 },
				});
				expect(
					requested.filter((url) => url.endsWith(`/repos/${repo}/traffic/views`)),
				).toHaveLength(1);
				expect(
					requested.filter((url) => url.endsWith(`/repos/${repo}/traffic/clones`)),
				).toHaveLength(2);
			}
			for (const [resource, snapshot] of snapshots)
				expect(await readSnapshot(db, run.account_id, resource)).toEqual({
					...snapshot,
					publication: { runId: run.id, publishedAt: run.finishedAt },
				});
			expect((await publishedFactory(db, run.account_id))?.repos).toHaveLength(4);
			expect(abandoned.message.ack).not.toHaveBeenCalled();
			expect(abandoned.message.retry).not.toHaveBeenCalled();
			expect(
				logged.mock.calls.some(([entry]) => String(entry).includes("factory_lease_release_error")),
			).toBe(false);
			release();
			await abandoned.pending;
			expect(await fixture.read()).toEqual(run);
		} finally {
			release();
			await abandoned?.pending;
		}
	},
);

it("keeps every earlier checkpoint when the next atomic pool save throws", async () => {
	const fixture = await setup();
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	let entered = 0;
	let release = () => {};
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			if (url.includes("/commits?")) {
				if (++entered === 4) release();
				await barrier;
			}
			return base(url, init);
		}),
	);
	const batch = fixture.env.DB.batch.bind(fixture.env.DB);
	let batches = 0;
	const failure = vi.spyOn(fixture.env.DB, "batch").mockImplementation(async (statements) => {
		if (++batches === 6) throw new Error("fixture D1 failure");
		return batch(statements);
	});
	const logged = vi.spyOn(console, "log").mockImplementation(() => {});
	await expect(
		executeRunPage(fixture.env, fixture.run.id, () => fixture.now),
	).rejects.toMatchObject({ code: "db_error" });
	let run = await fixture.read();
	expect(run.steps.filter((step) => step.status === "success")).toHaveLength(4);
	expect(run.steps.filter((step) => step.status === "running")).toHaveLength(4);
	expect(JSON.parse(String(logged.mock.calls.at(-1)?.[0]))).toMatchObject({
		stepsDone: 4,
		endReason: "save_failed",
		operation: "save",
	});
	failure.mockRestore();
	const retryAt = new Date(Date.parse(fixture.now) + 5_000).toISOString();
	for (let attempt = 0; run.status === "running" && attempt < 100; attempt++) {
		await executeRunPage(fixture.env, run.id, () =>
			run.nextAttemptAt > retryAt ? run.nextAttemptAt : retryAt,
		);
		run = await fixture.read();
	}
	expect(run.status).toBe("completed");
	for (const repo of run.repos)
		expect(run.steps.filter((step) => step.repo === repo && step.attempts > 1)).toHaveLength(1);
});

it("retains shared rate backoff while other repositories finish admitted requests", async () => {
	const fixture = await setup();
	vi.spyOn(Date, "now").mockReturnValue(Date.parse(fixture.now));
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			if (url.includes("/app0/commits?"))
				return Response.json(
					{ message: "limited" },
					{ status: 429, headers: { "retry-after": "1200" } },
				);
			return base(url, init);
		}),
	);
	await executeRunPage(fixture.env, fixture.run.id, () => fixture.now);
	let run = await fixture.read();
	const retryAt = new Date(Date.parse(fixture.now) + 1_200_000).toISOString();
	expect(run.nextAttemptAt).toBe(retryAt);
	expect(
		run.steps.find((step) => step.repo === "nocoo/app0" && step.kind === "commits"),
	).toMatchObject({ status: "pending", error: "github_rate_limited" });
	expect(run.steps.filter((step) => step.status === "running")).toHaveLength(0);
	expect(run.requests).toBeLessThanOrEqual(8);
	vi.stubGlobal("fetch", base);
	for (let attempt = 0; run.status === "running" && attempt < 100; attempt++) {
		await executeRunPage(fixture.env, run.id, () => run.nextAttemptAt);
		run = await fixture.read();
	}
	expect(run.status).toBe("completed");
	expect(run.steps.some((step) => step.error === "worker_interrupted")).toBe(false);
});

it("serializes shared snapshot merges without dropping another repository's rows", async () => {
	const fixture = await setup();
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const body = init?.body ? JSON.parse(String(init.body)) : {};
			if (
				String(body.query).includes("... on Issue {") &&
				String(body.query).includes("search(query")
			) {
				const name = /repo:([^ ]+)/.exec(String(body.variables.q))?.[1];
				return Response.json({
					data: {
						search: {
							issueCount: 1,
							pageInfo: { hasNextPage: false },
							nodes: [
								{
									__typename: "Issue",
									number: 1,
									title: name,
									url: `https://github.com/${name}/issues/1`,
									state: "OPEN",
									createdAt: fixture.now,
									updatedAt: fixture.now,
									author: { login: "nocoo" },
									labels: { nodes: [], pageInfo: { hasNextPage: false } },
									comments: { totalCount: 0 },
									repository: { nameWithOwner: name },
								},
							],
						},
					},
				});
			}
			return base(url, init);
		}),
	);
	let run = await fixture.read();
	for (let attempt = 0; run.status === "running" && attempt < 100; attempt++) {
		await executeRunPage(fixture.env, run.id, () => run.nextAttemptAt);
		run = await fixture.read();
	}
	expect(run.status).toBe("completed");
	const issues = await readSnapshot(createDb(fixture.env.DB), run.account_id, "issues");
	if (!issues) throw new Error("fixture");
	expect(
		(issues.issues as { name_with_owner: string }[]).map((issue) => issue.name_with_owner).sort(),
	).toEqual([...run.repos].sort());
});

it.each(["identity", "cooldown"])("propagates %s failures to deferred activity", async (reason) => {
	const fixture = await setup(true, reason === "cooldown" ? 3 : 4);
	if (reason === "cooldown") {
		await createDb(fixture.env.DB)
			.prepare("INSERT INTO factory_repo_state(account_id,repo,payload) VALUES(?,?,?)")
			.bind(
				fixture.run.account_id,
				"nocoo/app0",
				JSON.stringify({ nextAllowedAt: new Date(Date.parse(fixture.now) + 60_000).toISOString() }),
			)
			.run();
	} else {
		const base = vi.mocked(fetch).getMockImplementation();
		if (!base) throw new Error("fixture");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const response = await base(url, init);
				if (String(init?.body).includes('"name":"app0"')) {
					const body = (await response.json()) as { data: { repository: { id: string } } };
					body.data.repository.id = "replaced";
					return Response.json(body);
				}
				return response;
			}),
		);
	}
	await executeRunPage(fixture.env, fixture.run.id, () => fixture.now);
	const run = await fixture.read();
	expect(
		run.steps.find((step) => step.repo === "nocoo/app0" && step.kind === "activity"),
	).toMatchObject({
		status: "skipped",
		error: reason === "identity" ? "repository_failed" : "repository_cooldown",
	});
});

it("starts four details requests before any finishes, without holding the projection lock", async () => {
	const fixture = await setup();
	await executeRunPage(fixture.env, fixture.run.id, () => fixture.now);
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	let active = 0;
	let peak = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			if (/\/repos\/nocoo\/app[0-3]$/.test(url)) {
				active++;
				peak = Math.max(peak, active);
				await new Promise<void>((resolve) => setTimeout(resolve, 20));
				active--;
			}
			return base(url, init);
		}),
	);
	await executeRunPage(fixture.env, fixture.run.id, () => fixture.now);
	expect(peak).toBe(4);
});
