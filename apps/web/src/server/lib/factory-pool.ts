import {
	FACTORY_REPO_CONCURRENCY,
	type FactoryRun,
	type FactoryRunStep,
} from "../../lib/factory-run";
import type { FactorySnapshot } from "../../lib/factory-types";
import { type Db, guardedDb } from "./db/d1";
import { beginRunStep } from "./db/factory-run-journal";
import { fenced, type RunLease, rebindRunWrites, saveRun } from "./db/factory-runs";
import {
	type FactoryInvocation,
	INVOCATION_STATEMENTS,
	InvocationStopped,
} from "./factory-invocation";
import { boundedJson } from "./factory-publish";
import { assertFactoryReserve, recordFactoryRate } from "./factory-rate";

export type PoolStepHooks = {
	begin: (step: FactoryRunStep) => Promise<boolean>;
	heartbeat: () => Promise<void>;
	project: () => Promise<void>;
};

export function poolSteps(run: FactoryRun): Map<string, number[]> {
	const selected = new Map<string, number[]>();
	if (
		run.mode !== "refresh" ||
		new Set(run.steps.map((step) => step.repo).filter(Boolean)).size < 2
	)
		return selected;
	const remaining = run.steps
		.map((step, index) => ({ step, index }))
		.filter(({ step }) => step.status === "pending" || step.status === "running");
	const first = remaining.find(({ step }) => step.kind !== "activity");
	if (!first?.step.repo) return selected;
	const snapshots = first.step.kind === "snapshot";
	for (const { step, index } of remaining) {
		if (step.kind === "activity") continue;
		if (!step.repo || (step.kind === "snapshot") !== snapshots) break;
		if (!selected.has(step.repo)) {
			if (selected.size === FACTORY_REPO_CONCURRENCY) continue;
			selected.set(step.repo, []);
		}
		selected.get(step.repo)?.push(index);
	}
	return selected;
}

function mergeRates(target: FactorySnapshot, source: FactorySnapshot | null) {
	for (const rate of Object.values({
		...source?.rateLimits,
		...(source?.rate ? { [source.rate.resource]: source.rate } : {}),
	})) {
		if (rate.resource !== "core" && rate.resource !== "graphql") continue;
		const previous = target.rateLimits?.[rate.resource];
		if (previous?.resetAt === rate.resetAt && previous.remaining < rate.remaining) continue;
		if (previous?.resetAt && rate.resetAt && previous.resetAt > rate.resetAt) continue;
		recordFactoryRate(target, { ...rate, resource: rate.resource });
	}
}

export async function executeRepoPool(
	db: Db,
	lease: RunLease,
	invocation: FactoryInvocation,
	repositories: Map<string, number[]>,
	execute: (
		db: Db,
		lane: RunLease,
		step: FactoryRunStep,
		hooks: PoolStepHooks,
	) => Promise<{ writes: D1PreparedStatement[]; stop: boolean }>,
	operation: (value: "heartbeat" | "step" | "save") => void,
	progress: (steps: number, writes: number) => void,
) {
	const initial = structuredClone(lease.run);
	const owner = initial.checkpoint?.repos.length === 1 ? initial.checkpoint.repos[0] : undefined;
	let checkpointToPreserve =
		owner &&
		initial.checkpoint?.runId === initial.id &&
		initial.repoIds[owner.name] === owner.id &&
		initial.steps.some(
			(step) => step.repo === owner.name && step.kind === "metadata" && step.status === "success",
		)
			? { repo: owner.name, snapshot: initial.checkpoint }
			: null;
	let tail = Promise.resolve();
	async function acquire() {
		let release = () => {};
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const previous = tail;
		tail = previous.then(() => current);
		await previous;
		return release;
	}
	let failure: unknown;
	let failureOperation: "heartbeat" | "step" | "save" = "step";
	const lanes: RunLease[] = [];
	const stepDb = guardedDb(db, () => {
		if (invocation.statementCost >= INVOCATION_STATEMENTS) throw new InvocationStopped();
	});
	await Promise.all(
		[...repositories].map(async ([repo, indices]) => {
			let release: (() => void) | undefined;
			let pendingWrites = 0;
			let phase: typeof failureOperation = "step";
			try {
				const saved = await stepDb
					.prepare(
						"SELECT payload FROM factory_resources WHERE run_id=? AND repo=? AND stream='executor:checkpoint'",
					)
					.bind(lease.run.id, repo)
					.first<{ payload: string }>();
				const run = structuredClone(initial);
				if (saved) run.checkpoint = JSON.parse(saved.payload) as FactorySnapshot;
				const lane: RunLease = {
					run,
					token: lease.token,
					version: lease.version,
					leaseUntil: lease.leaseUntil,
				};
				lanes.push(lane);
				async function lock() {
					release ??= await acquire();
				}
				async function heartbeat() {
					const owned = Boolean(release);
					await lock();
					try {
						if (failure) throw new InvocationStopped(true);
						phase = "heartbeat";
						await invocation.heartbeat();
						if (lease.run.checkpoint) {
							for (const current of lanes) mergeRates(lease.run.checkpoint, current.run.checkpoint);
							assertFactoryReserve(lease.run.checkpoint, invocation.clock());
						}
						lane.version = lease.version;
						lane.leaseUntil = lease.leaseUntil;
					} finally {
						if (!owned) {
							release?.();
							release = undefined;
						}
					}
				}
				for (const index of indices) {
					const step = run.steps[index];
					if (!step) continue;
					while (step.status === "pending" || step.status === "running") {
						if (
							failure ||
							invocation.endReason(step, true) ||
							lease.run.nextAttemptAt > invocation.clock()
						)
							return;
						run.cursor = index;
						const requestsBefore = run.requests;
						const result = await execute(stepDb, lane, step, {
							heartbeat,
							project: lock,
							begin: async (started) => {
								await lock();
								try {
									if (failure || invocation.stopped) throw new InvocationStopped();
									phase = "heartbeat";
									await invocation.heartbeat();
									phase = "step";
									lease.run.steps[index] = structuredClone(started);
									lane.version = lease.version;
									return await beginRunStep(db, lease, invocation.clock(), index);
								} finally {
									release?.();
									release = undefined;
								}
							},
						});
						pendingWrites =
							result.writes.length +
							(run.checkpoint && step.kind !== "snapshot" ? 1 : 0) +
							(checkpointToPreserve ? 1 : 0);
						invocation.pendingWrites += pendingWrites;
						await lock();
						if (failure) return;
						phase = "save";
						operation(phase);
						const central = lease.run;
						run.steps.forEach((current, candidate) => {
							if (current.repo === repo) central.steps[candidate] = structuredClone(current);
						});
						central.requests += run.requests - requestsBefore;
						central.nextAttemptAt =
							central.nextAttemptAt > run.nextAttemptAt ? central.nextAttemptAt : run.nextAttemptAt;
						if (run.status !== "running") central.status = run.status;
						if (run.finishedAt) central.finishedAt = run.finishedAt;
						const previous = central.checkpoint;
						if (run.checkpoint) {
							central.checkpoint = structuredClone(run.checkpoint);
							mergeRates(central.checkpoint, previous);
							for (const current of lanes) mergeRates(central.checkpoint, current.run.checkpoint);
						}
						while (
							central.steps[central.cursor] &&
							!["pending", "running"].includes(central.steps[central.cursor]?.status ?? "")
						)
							central.cursor++;
						const writes = rebindRunWrites(db, lease, result.writes);
						if (checkpointToPreserve)
							writes.push(
								fenced(
									db,
									lease,
									invocation.clock(),
									"INSERT INTO factory_resources(run_id,repo,stream,payload) SELECT ?,?,'executor:checkpoint',? WHERE $guard ON CONFLICT(run_id,repo,stream) DO NOTHING",
									[
										central.id,
										checkpointToPreserve.repo,
										boundedJson(checkpointToPreserve.snapshot),
									],
								),
							);
						if (run.checkpoint && step.kind !== "snapshot")
							writes.push(
								fenced(
									db,
									lease,
									invocation.clock(),
									"INSERT INTO factory_resources(run_id,repo,stream,payload) SELECT ?,?,'executor:checkpoint',? WHERE $guard ON CONFLICT(run_id,repo,stream) DO UPDATE SET payload=excluded.payload",
									[central.id, repo, boundedJson(run.checkpoint)],
								),
							);
						progress(0, writes.length);
						if (
							!(await saveRun(
								db,
								lease,
								writes,
								invocation.clock(),
								central.status === "running",
								index,
							))
						)
							throw new InvocationStopped(true);
						checkpointToPreserve = null;
						if (!["pending", "running"].includes(step.status)) progress(1, 0);
						invocation.pendingWrites -= pendingWrites;
						pendingWrites = 0;
						release?.();
						release = undefined;
						if (result.stop || central.status !== "running") invocation.stopped = true;
					}
				}
			} catch (error) {
				if (error instanceof InvocationStopped && !error.lostLease) {
					invocation.stopped = true;
					return;
				}
				if (!failure) {
					failure = error;
					failureOperation = phase;
				}
				invocation.stopped = true;
			} finally {
				invocation.pendingWrites -= pendingWrites;
				release?.();
			}
		}),
	);
	if (failure) {
		operation(failureOperation);
		throw failure;
	}
}
