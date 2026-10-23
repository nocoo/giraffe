import { type FactoryRunStep, RUN_LEASE_MS } from "../../lib/factory-run";
import type { FactoryStreamData } from "../../lib/factory-types";
import type { Db } from "./db/d1";
import { renewRunLease } from "./db/factory-run-journal";
import type { RunLease } from "./db/factory-runs";
import { ApiError } from "./errors";
import type { FactoryEndReason } from "./factory-log";

export const INVOCATION_WALL_MS = 25_000;
export const INVOCATION_REQUESTS = 40;
export const INVOCATION_STATEMENTS = 600;
export const INVOCATION_DB_STATEMENTS = 800;

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
	private worked = false;

	constructor(
		readonly db: Db,
		readonly lease: RunLease,
		readonly clock: () => string,
	) {
		this.started = Date.parse(clock());
	}

	canStart(step: FactoryRunStep, _continuing = false) {
		return this.endReason(step) === null;
	}

	endReason(step: FactoryRunStep): FactoryEndReason | null {
		if (Date.parse(this.clock()) - this.started >= INVOCATION_WALL_MS) return "wall";
		if (this.requests >= INVOCATION_REQUESTS) return "requests";
		if (this.db.statements + this.writes.length >= INVOCATION_STATEMENTS) return "statements";
		if (
			this.worked &&
			(step.kind === "publish" || step.kind === "activity" || step.resource === "insights")
		)
			return "publish_boundary";
		if (this.snapshotRepo !== undefined && this.snapshotRepo !== step.repo)
			return "snapshot_boundary";
		return null;
	}

	completed(step: FactoryRunStep) {
		this.worked = true;
		if (step.kind === "snapshot") this.snapshotRepo = step.repo;
		return step.kind === "snapshot" && !step.repo;
	}

	async heartbeat() {
		const now = this.clock();
		if (Date.parse(this.lease.leaseUntil) - Date.parse(now) > RUN_LEASE_MS / 2) return;
		if (!(await renewRunLease(this.db, this.lease, now))) throw new InvocationStopped(true);
	}

	async beforeRequest() {
		if (
			Date.parse(this.clock()) - this.started >= INVOCATION_WALL_MS - 5_000 ||
			this.requests >= INVOCATION_REQUESTS ||
			this.db.statements + this.writes.length >= INVOCATION_STATEMENTS
		)
			throw new InvocationStopped();
		await this.heartbeat();
		this.requests++;
	}
}
