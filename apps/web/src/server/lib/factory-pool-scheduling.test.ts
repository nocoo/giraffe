import { afterEach, expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import {
	FACTORY_REPO_CONCURRENCY,
	type FactoryRunStep,
	makeRun,
	RUN_LEASE_MS,
} from "../../lib/factory-run";
import type { FactoryRate } from "../../lib/factory-types";
import { createDb } from "./db/d1";
import { claimRun, fenced, getRun, releaseRunLease, startRun } from "./db/factory-runs";
import {
	FactoryInvocation,
	INVOCATION_DB_STATEMENTS,
	INVOCATION_REQUESTS,
	INVOCATION_STATEMENTS,
	InvocationStopped,
} from "./factory-invocation";
import { executeRepoPool, poolSteps } from "./factory-pool";

afterEach(() => {
	vi.restoreAllMocks();
});

function step(kind: FactoryRunStep["kind"], repo: string | null): FactoryRunStep {
	return {
		kind,
		repo,
		status: "pending",
		attempts: 0,
		startedAt: null,
		finishedAt: null,
		durationMs: 0,
		pages: 0,
		error: null,
	};
}

function runFixture(count = 7) {
	const snapshot = factoryFixture();
	const first = snapshot.repos[0];
	if (!first) throw new Error("fixture repository missing");
	const repos = Array.from({ length: count }, (_, index) => ({
		...structuredClone(first),
		id: `repo-${index}`,
		name: `nocoo/app${index}`,
	}));
	const run = makeRun(
		"pool-scheduler",
		"a",
		"nocoo",
		"scheduler",
		"refresh",
		repos,
		snapshot.fetched_at,
		[],
		repos.map((repo) => repo.name),
		{ scope: "selected" },
		"quick",
	);
	run.trigger = "daily";
	run.steps = [
		...repos.map((repo) => step("metadata", repo.name)),
		...repos.map((repo) => step("snapshot", repo.name)),
		...repos.map((repo) => step("activity", repo.name)),
		step("publish", null),
	];
	return run;
}

async function setup(run = runFixture()) {
	const raw = sqliteFixture();
	const db = createDb(raw, undefined, INVOCATION_DB_STATEMENTS);
	const now = run.startedAt;
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','nocoo','encrypted','fake',?,?)",
		)
		.bind(now, now)
		.run();
	await startRun(db, run);
	const lease = await claimRun(db, run.id, now);
	if (!lease) throw new Error("fixture lease missing");
	const invocation = new FactoryInvocation(db, lease, () => now);
	async function read() {
		const found = await getRun(createDb(raw), run.account_id, run.id);
		if (!found) throw new Error("fixture run missing");
		return found.run;
	}
	return { db, raw, now, lease, invocation, read };
}

it("selects every repository across factory, snapshot and activity work before publication", () => {
	const run = runFixture();
	const selected = poolSteps(run);
	expect([...selected.keys()]).toEqual(run.repos);
	for (const repo of run.repos)
		expect(selected.get(repo)?.map((index) => run.steps[index]?.kind)).toEqual([
			"metadata",
			"snapshot",
			"activity",
		]);
});

it("pools continuing activity pages even when only one repository remains", () => {
	const run = runFixture(1);
	for (const current of run.steps) if (current.kind !== "activity") current.status = "success";
	expect([...poolSteps(run)]).toEqual([[run.repos[0], [2]]]);
});

it.each(["snapshot", "activity-contributions", "publish"] as const)(
	"does not admit repository work past a pending global %s barrier",
	(kind) => {
		const run = runFixture(2);
		run.steps = [step("activity", "nocoo/app0"), step(kind, null), step("metadata", "nocoo/app1")];
		expect([...poolSteps(run)]).toEqual([["nocoo/app0", [0]]]);
		run.steps[0] = step(kind, null);
		expect(poolSteps(run).size).toBe(0);
	},
);

it("ignores accepted global barriers but never pools a catalogue run", () => {
	const run = runFixture(2);
	run.steps.splice(1, 0, { ...step("contributions", null), status: "success" });
	expect(poolSteps(run).size).toBe(2);
	run.mode = "catalog";
	expect(poolSteps(run).size).toBe(0);
});

it("protects a legacy root without copying its identity into an activity-only repository", async () => {
	const run = runFixture(2);
	for (const current of run.steps)
		if (current.kind !== "activity" && current.repo) current.status = "success";
	const fixture = await setup(run);
	const checkpoint = factoryFixture();
	const owner = checkpoint.repos[0];
	if (!owner) throw new Error("fixture checkpoint missing");
	checkpoint.runId = run.id;
	checkpoint.repos = [{ ...owner, id: "repo-0", name: "nocoo/app0" }];
	fixture.lease.run.checkpoint = checkpoint;
	const index = fixture.lease.run.steps.findIndex(
		(current) => current.repo === "nocoo/app1" && current.kind === "activity",
	);
	await executeRepoPool(
		fixture.db,
		fixture.lease,
		fixture.invocation,
		new Map([["nocoo/app1", [index]]]),
		async (_db, _lane, current, hooks) => {
			expect(await hooks.begin(current)).toBe(true);
			current.status = "success";
			return { writes: [], stop: false };
		},
		() => {},
		() => {},
	);
	const resources = await fixture.db
		.prepare(
			"SELECT repo,payload FROM factory_resources WHERE run_id=? AND stream='executor:checkpoint'",
		)
		.bind(run.id)
		.all<{ repo: string; payload: string }>();
	expect(resources.results).toHaveLength(1);
	expect(resources.results[0]?.repo).toBe("nocoo/app0");
	expect(JSON.parse(resources.results[0]?.payload ?? "null")).toEqual(checkpoint);
});

it("retains shared rate minima and newer resets while lanes steal another repository", async () => {
	const run = runFixture();
	run.steps = run.steps.filter((current) => current.kind === "metadata" || !current.repo);
	const fixture = await setup(run);
	const resetAt = new Date(Date.parse(fixture.now) + 3_600_000).toISOString();
	const nextReset = new Date(Date.parse(resetAt) + 3_600_000).toISOString();
	const core = { resource: "core", remaining: 500, resetAt };
	const graphql = { resource: "graphql", remaining: 900, resetAt };
	fixture.lease.run.checkpoint = {
		...factoryFixture(),
		rate: core,
		rateLimits: { core, graphql },
	};
	const rates: (FactoryRate | null)[] = [
		{ ...core, remaining: 400 },
		{ ...core, remaining: 800 },
		{ ...core, remaining: 0, resetAt: fixture.now },
		{ ...graphql, remaining: 600 },
		{ ...core, remaining: 700, resetAt: nextReset },
		{ resource: "search", remaining: 0, resetAt: nextReset },
		null,
	];
	await executeRepoPool(
		fixture.db,
		fixture.lease,
		fixture.invocation,
		poolSteps(fixture.lease.run),
		async (_db, lane, current, hooks) => {
			expect(await hooks.begin(current)).toBe(true);
			lane.run.checkpoint = {
				...factoryFixture(),
				rate: rates[run.repos.indexOf(String(current.repo))] ?? null,
			};
			await hooks.heartbeat();
			current.status = "success";
			return { writes: [], stop: false };
		},
		() => {},
		() => {},
	);
	expect((await fixture.read()).checkpoint?.rateLimits).toEqual({
		core: { ...core, remaining: 700, resetAt: nextReset },
		graphql: { ...graphql, remaining: 600 },
	});
});

it("persists an account pause before admitting more repository work", async () => {
	const fixture = await setup(runFixture(1));
	let started = 0;
	await executeRepoPool(
		fixture.db,
		fixture.lease,
		fixture.invocation,
		poolSteps(fixture.lease.run),
		async (_db, lane, current, hooks) => {
			expect(await hooks.begin(current)).toBe(true);
			started++;
			current.error = "github_unauthorized";
			lane.run.status = "paused";
			return { writes: [], stop: false };
		},
		() => {},
		() => {},
	);
	expect(started).toBe(1);
	expect(fixture.invocation.stopped).toBe(true);
	expect((await fixture.read()).status).toBe("paused");
	expect((await fixture.read()).steps[0]).toMatchObject({
		status: "pending",
		error: "github_unauthorized",
	});
});

it("caps active repositories at four when the work queue contains more than four", async () => {
	const fixture = await setup();
	let active = 0;
	let peak = 0;
	const repositories = new Map(
		fixture.lease.run.repos.map((repo) => [
			repo,
			fixture.lease.run.steps.flatMap((current, index) => (current.repo === repo ? [index] : [])),
		]),
	);
	await executeRepoPool(
		fixture.db,
		fixture.lease,
		fixture.invocation,
		repositories,
		async (_db, _lane, current, hooks) => {
			expect(await hooks.begin(current)).toBe(true);
			active++;
			peak = Math.max(peak, active);
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
			active--;
			current.status = "success";
			return { writes: [], stop: false };
		},
		() => {},
		() => {},
	);
	expect(peak).toBe(FACTORY_REPO_CONCURRENCY);
	expect(
		(await fixture.read()).steps.filter((current) => current.repo && current.status !== "success"),
	).toEqual([]);
});

it("steals queued work and reaches another repository's activity before a slow lane finishes", async () => {
	const fixture = await setup();
	expect(poolSteps(fixture.lease.run).size).toBe(7);
	let release = () => {};
	const slow = new Promise<void>((resolve) => {
		release = resolve;
	});
	const completed: string[] = [];
	await executeRepoPool(
		fixture.db,
		fixture.lease,
		fixture.invocation,
		poolSteps(fixture.lease.run),
		async (_db, _lane, current, hooks) => {
			expect(await hooks.begin(current)).toBe(true);
			if (current.repo === "nocoo/app0" && current.kind === "metadata") await slow;
			completed.push(`${current.repo}:${current.kind}`);
			if (current.repo === "nocoo/app4" && current.kind === "activity") release();
			current.status = "success";
			return { writes: [], stop: false };
		},
		() => {},
		() => {},
	);
	expect(completed.indexOf("nocoo/app4:activity")).toBeLessThan(
		completed.indexOf("nocoo/app0:metadata"),
	);
	for (const repo of fixture.lease.run.repos)
		expect(completed.filter((value) => value.startsWith(`${repo}:`))).toEqual([
			`${repo}:metadata`,
			`${repo}:snapshot`,
			`${repo}:activity`,
		]);
	expect((await fixture.read()).steps.at(-1)?.status).toBe("pending");
});

it.each(["requests", "statements", "wall"] as const)(
	"saves each accepted activity page and stops all lanes at the shared %s budget",
	async (budget) => {
		const run = runFixture(7);
		run.steps = run.steps.filter((current) => current.kind === "activity" || !current.repo);
		const fixture = await setup(run);
		let time = fixture.now;
		const invocation = new FactoryInvocation(fixture.db, fixture.lease, () => time);
		let accepted = 0;
		await executeRepoPool(
			fixture.db,
			fixture.lease,
			invocation,
			poolSteps(fixture.lease.run),
			async (_db, lane, current, hooks) => {
				current.attempts = 1;
				current.status = "running";
				expect(await hooks.begin(current)).toBe(true);
				await invocation.beforeRequest(hooks.heartbeat);
				current.pages++;
				lane.run.requests++;
				accepted++;
				if (accepted === 8 && budget === "statements")
					invocation.pendingWrites = INVOCATION_STATEMENTS;
				if (accepted === 8 && budget === "wall")
					time = new Date(Date.parse(time) + 25_000).toISOString();
				return {
					writes: [
						fenced(
							fixture.db,
							lane,
							fixture.now,
							"INSERT INTO factory_resources(run_id,repo,stream,payload) SELECT ?,?,'activity',? WHERE $guard ON CONFLICT(run_id,repo,stream) DO UPDATE SET payload=excluded.payload",
							[lane.run.id, current.repo, JSON.stringify({ pages: current.pages })],
						),
					],
					stop: false,
				};
			},
			() => {},
			() => {},
		);
		const saved = await fixture.read();
		expect(saved.steps.reduce((total, current) => total + current.pages, 0)).toBe(accepted);
		expect(accepted).toBeGreaterThanOrEqual(8);
		expect(accepted).toBeLessThanOrEqual(INVOCATION_REQUESTS);
		expect(saved.steps.some((current) => current.pages > 1)).toBe(true);
		for (const current of saved.steps.filter((candidate) => candidate.pages > 0)) {
			const row = await createDb(fixture.raw)
				.prepare(
					"SELECT payload FROM factory_resources WHERE run_id=? AND repo=? AND stream='activity'",
				)
				.bind(saved.id, current.repo)
				.first<{ payload: string }>();
			expect(JSON.parse(row?.payload ?? "null")).toEqual({ pages: current.pages });
		}
		expect(invocation.requests).toBeLessThanOrEqual(INVOCATION_REQUESTS);
	},
);

it("keeps accepted pages through takeover with at most one unaccepted step per active lane", async () => {
	const fixture = await setup();
	expect(poolSteps(fixture.lease.run).size).toBe(7);
	let entered = 0;
	await expect(
		executeRepoPool(
			fixture.db,
			fixture.lease,
			fixture.invocation,
			poolSteps(fixture.lease.run),
			async (_db, _lane, current, hooks) => {
				current.status = "running";
				current.attempts = 1;
				expect(await hooks.begin(current)).toBe(true);
				if (++entered > 10) throw new InvocationStopped(true);
				current.status = "success";
				return { writes: [], stop: false };
			},
			() => {},
			() => {},
		),
	).rejects.toMatchObject({ code: "factory_lease_lost" });
	const before = await fixture.read();
	const accepted = before.steps.filter((current) => current.status === "success");
	expect(accepted.length).toBeGreaterThan(4);
	const inFlight = before.steps.filter((current) => current.status === "running");
	expect(inFlight.length).toBeLessThanOrEqual(FACTORY_REPO_CONCURRENCY);
	expect(new Set(inFlight.map((current) => current.repo)).size).toBe(inFlight.length);
	const resumedAt = new Date(Date.parse(fixture.now) + RUN_LEASE_MS).toISOString();
	await releaseRunLease(fixture.db, fixture.lease, fixture.now);
	const lease = await claimRun(fixture.db, before.id, resumedAt);
	if (!lease) throw new Error("fixture replacement lease missing");
	await executeRepoPool(
		fixture.db,
		lease,
		new FactoryInvocation(fixture.db, lease, () => resumedAt),
		poolSteps(lease.run),
		async (_db, _lane, current, hooks) => {
			current.attempts = current.error ? current.attempts + 1 : 1;
			current.error = null;
			expect(await hooks.begin(current)).toBe(true);
			current.status = "success";
			return { writes: [], stop: false };
		},
		() => {},
		() => {},
	);
	const after = await fixture.read();
	for (const current of accepted)
		expect(
			after.steps.find(
				(candidate) => candidate.repo === current.repo && candidate.kind === current.kind,
			),
		).toEqual(current);
	expect(after.steps.filter((current) => current.attempts > 1)).toHaveLength(inFlight.length);
});
