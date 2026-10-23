import type { FactoryRunStep } from "../../lib/factory-run";
import type { FactoryStreamData } from "../../lib/factory-types";
import type { Db } from "./db/d1";
import { recordRunRequest, renewRunLease } from "./db/factory-run-journal";
import type { RunLease } from "./db/factory-runs";
import { ApiError } from "./errors";

export const INVOCATION_WALL_MS = 25_000;
export const INVOCATION_REQUESTS = 40;
export const INVOCATION_STATEMENTS = 36;

export class InvocationStopped extends ApiError {
	constructor(readonly lostLease = false) {
		super(409, lostLease ? "factory_lease_lost" : "factory_yield", "factory invocation stopped");
	}
}

export class FactoryInvocation {
	readonly resources = new Map<string, FactoryStreamData>();
	readonly writes: D1PreparedStatement[] = [];
	requests = 0;
	private readonly started: number;
	private snapshotRepo: string | null | undefined;

	constructor(
		readonly db: Db,
		readonly lease: RunLease,
		readonly clock: () => string,
	) {
		this.started = Date.parse(clock());
	}

	canStart(step: FactoryRunStep, continuing = false) {
		return (
			(continuing || Date.parse(this.clock()) - this.started < INVOCATION_WALL_MS) &&
			this.requests < INVOCATION_REQUESTS &&
			this.db.statements + this.writes.length < INVOCATION_STATEMENTS &&
			(!this.writes.length ||
				(step.kind !== "publish" &&
					step.kind !== "activity" &&
					step.resource !== "insights" &&
					(this.snapshotRepo === undefined || this.snapshotRepo === step.repo)))
		);
	}

	completed(step: FactoryRunStep) {
		if (step.kind === "snapshot") this.snapshotRepo = step.repo;
		return step.kind === "snapshot" && (!step.repo || step.status === "running");
	}

	async heartbeat() {
		const now = this.clock();
		if (Date.parse(this.lease.leaseUntil) - Date.parse(now) > 30_000) return;
		if (!(await renewRunLease(this.db, this.lease, now))) throw new InvocationStopped(true);
	}

	async beforeRequest() {
		if (this.requests >= INVOCATION_REQUESTS || this.db.statements + this.writes.length >= 60)
			throw new InvocationStopped();
		await this.heartbeat();
		if (!(await recordRunRequest(this.db, this.lease, this.clock())))
			throw new InvocationStopped(true);
		this.requests++;
	}
}
