import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, it, vi } from "vitest";
import type {
	DependencyPlan,
	IssueCandidate,
	LiveIssue,
	RepairProgress,
	RepairReview,
} from "./repair-contracts.ts";
import {
	assertDependencyOutcome,
	assertDependencyPlan,
	assertReviewSignoff,
	createRepairEngine,
	type RepairModels,
} from "./repair-engine.ts";
import { LocalCleanupError } from "./repair-local.ts";
import { LiveStateChanged } from "./repair-source.ts";
import {
	type CheckReceipt,
	WorkspaceDriver,
	WorkspaceError,
	type WorkspaceSnapshot,
} from "./repair-workspace.ts";

const now = "2026-10-02T13:00:00.000Z";
const sha = "a".repeat(40),
	head = "b".repeat(40);
const candidate: IssueCandidate = {
	repository: "owner/repo",
	number: 1,
	title: "Upgrade demo to 2.0.0",
	url: "https://github.com/owner/repo/issues/1",
	labels: ["dependencies"],
	updatedAt: now,
	sourceVersion: "source",
	fetchedAt: now,
};
const issue: LiveIssue = {
	...candidate,
	body: "Upgrade demo from 1.0.0 to 2.0.0",
	state: "open",
	author: "owner",
	baseSha: sha,
	defaultBranch: "main",
	repositoryId: "1",
	verifiedAt: now,
};
const plan: DependencyPlan = {
	decision: "repair",
	reason: "Dependency upgrade requested.",
	manifest: "package.json",
	section: "dependencies",
	dependency: "demo",
	targetVersion: "2.0.0",
	provenance: "original",
	provenanceReason: "Owner-created application evidence at base SHA.",
};
const snapshot: WorkspaceSnapshot = {
	head,
	tree: "tree",
	baseTree: "base-tree",
	contentFingerprint: "fingerprint",
	diffDigest: "diff",
	changedPaths: ["package-lock.json", "package.json"],
	diff: "dependency diff",
	manifestBeforeAfter: {
		"package.json": {
			before: '{"dependencies":{"demo":"1.0.0"}}',
			after: '{"dependencies":{"demo":"2.0.0"}}',
		},
	},
	complete: true,
};
const checks: CheckReceipt = {
	contentFingerprint: "fingerprint",
	validationDigest: "validation",
	commands: ["test"],
	results: [{ command: "test", exitCode: 0, stdout: "passed", stderr: "" }],
};
const review = (round: number): RepairReview => ({
	verdict: "signoff",
	summary: "Signoff",
	findings: [],
	head,
	contentFingerprint: "fingerprint",
	validationDigest: "validation",
	reviewedRound: round,
});
async function setup(harness?: Harness) {
	const session =
		harness ??
		(await Harness.open(
			new MemoryStorage(),
			{ models: createModels(), registry: createRegistry() },
			BACKGROUND_CONTEXT,
		));
	const driver = new WorkspaceDriver({ profiles: {} });
	const prepare = vi.spyOn(driver, "prepare").mockImplementation(async (input) => ({
		...input,
		path: "/fixture",
		branch: `giraffe/${input.id}`,
	}));
	vi.spyOn(driver, "readFile").mockResolvedValue('{"dependencies":{"demo":"1.0.0"}}');
	vi.spyOn(driver, "snapshot").mockResolvedValue(snapshot);
	vi.spyOn(driver, "updateDependency").mockResolvedValue(snapshot);
	const check = vi.spyOn(driver, "check").mockResolvedValue(checks);
	const commit = vi.spyOn(driver, "commit").mockResolvedValue(snapshot);
	const push = vi
		.spyOn(driver, "push")
		.mockResolvedValue({ head, branch: "giraffe/deps-1", reconciled: false });
	const models: RepairModels = {
		plan: vi.fn(async () => plan),
		work: vi.fn(async () => ({ conversationId: 2, summary: "Fixed" })),
		review: vi.fn(async (input) => ({ conversationId: 3, review: review(input.round) })),
	};
	const states: RepairProgress[] = [];
	const verify = vi.fn(async () => issue);
	const admission = vi.fn(async () => ({ eligible: true, reason: "Allowed" }));
	const publish = vi.fn(async (value: RepairProgress) => {
		states.push(structuredClone(value));
	});
	const opts = {
		harness: session,
		driver,
		models,
		verify,
		admit: admission,
		verifyPackage: vi.fn(async () => {}),
		publish,
		isPaused: async () => false,
		maxRounds: 20,
		allowPush: true,
		now: () => now,
	};
	return {
		harness: session,
		driver,
		prepare,
		check,
		commit,
		push,
		models,
		states,
		opts,
		verify,
		admission,
		publish,
	};
}

it("allows push only after exact independent signoff and fresh validation", async () => {
	const f = await setup();
	try {
		const engine = createRepairEngine(f.opts);
		const result = await engine.run(candidate);
		expect(result.stage).toBe("pushed");
		expect(result.round).toBe(1);
		expect(f.states.map((state) => state.stage)).toContain("reviewing");
		expect(f.push).toHaveBeenCalledOnce();
		expect(f.verify).toHaveBeenCalledTimes(2);
		await engine.run(candidate);
		expect(f.push).toHaveBeenCalledOnce();
		expect((await engine.state(result.id)).stage).toBe("pushed");
		await engine.trace(result.id, "Trace verified");
	} finally {
		await f.harness.close(BACKGROUND_CONTEXT);
	}
});
it("stops at20 change-request rounds and never pushes", async () => {
	const f = await setup();
	vi.mocked(f.models.review).mockImplementation(async (input) => ({
		conversationId: 3,
		review: {
			...review(input.round),
			verdict: "changes_requested",
			findings: [{ severity: "P1", path: "package.json", message: "Fix required" }],
		},
	}));
	try {
		const result = await createRepairEngine(f.opts).run(candidate);
		expect(result.stage).toBe("exhausted");
		expect(result.round).toBe(20);
		expect(f.models.work).toHaveBeenCalledTimes(20);
		expect(f.models.review).toHaveBeenCalledTimes(20);
		expect(f.push).not.toHaveBeenCalled();
		expect(result.events.length).toBeLessThanOrEqual(80);
		for (const limit of [0, 21, 1.5])
			expect(() => createRepairEngine({ ...f.opts, maxRounds: limit })).toThrow();
	} finally {
		await f.harness.close(BACKGROUND_CONTEXT);
	}
});
it("failed checks consume a bounded round, cannot bypass reviewer", async () => {
	const f = await setup();
	f.check
		.mockRejectedValue(new Error("test failed"))
		.mockRejectedValueOnce(new WorkspaceError("test failed", "TypeError: update the import"));
	try {
		const result = await createRepairEngine({ ...f.opts, maxRounds: 2 }).run(candidate);
		expect(result.stage).toBe("exhausted");
		expect(f.models.work).toHaveBeenCalledTimes(2);
		expect(vi.mocked(f.models.work).mock.calls[1]?.[0].feedback).toContain("TypeError");
		expect(f.models.review).not.toHaveBeenCalled();
		expect(f.push).not.toHaveBeenCalled();
	} finally {
		await f.harness.close(BACKGROUND_CONTEXT);
	}
});
it("blocks changed GitHub state or stale final signoff, and supports signoff-only mode", async () => {
	for (const mode of ["changed", "stale", "signoff-only", "review-blocked"] as const) {
		const f = await setup();
		if (mode === "changed")
			f.verify
				.mockResolvedValueOnce(issue)
				.mockResolvedValue({ ...issue, baseSha: "c".repeat(40) });
		if (mode === "stale")
			f.check
				.mockResolvedValueOnce(checks)
				.mockResolvedValueOnce(checks)
				.mockResolvedValue({ ...checks, validationDigest: "changed" });
		if (mode === "review-blocked")
			vi.mocked(f.models.review).mockImplementation(async (input) => ({
				conversationId: 3,
				review: { ...review(input.round), verdict: "blocked" },
			}));
		try {
			const result = await createRepairEngine({
				...f.opts,
				allowPush: mode !== "signoff-only",
			}).run(candidate);
			expect(result.stage).toBe(mode === "signoff-only" ? "signed_off" : "blocked");
			expect(f.push).not.toHaveBeenCalled();
		} finally {
			await f.harness.close(BACKGROUND_CONTEXT);
		}
	}
});
it("defer, missing workspace, unavailable installs and pause cannot edit/push", async () => {
	for (const mode of ["defer", "workspace", "install", "pause", "plan"] as const) {
		const f = await setup();
		if (mode === "defer")
			f.admission.mockResolvedValue({ eligible: false, reason: "out of scope" });
		if (mode === "workspace") f.prepare.mockRejectedValue(new Error("missing local Git"));
		if (mode === "install")
			vi.mocked(f.driver.updateDependency).mockRejectedValue(new Error("offline"));
		if (mode === "plan")
			vi.mocked(f.models.plan).mockResolvedValue({
				...plan,
				decision: "defer",
				provenance: "unknown",
			});
		try {
			const result = await createRepairEngine({
				...f.opts,
				isPaused: async () => mode === "pause",
			}).run(candidate);
			expect(result.stage).toBe(mode === "pause" ? "discovered" : "blocked");
			expect(f.push).not.toHaveBeenCalled();
		} finally {
			await f.harness.close(BACKGROUND_CONTEXT);
		}
	}
});
it("resumes SQLite state after telemetry outage without resetting review rounds", async () => {
	const dir = await mkdtemp(join(tmpdir(), "giraffe-repair-engine-"));
	const database = join(dir, "state.sqlite");
	let harness = await Harness.open(
		await openNodeSqliteStorage(database),
		{ models: createModels(), registry: createRegistry() },
		BACKGROUND_CONTEXT,
	);
	try {
		let f = await setup(harness);
		let interrupted = false;
		f.publish.mockImplementation(async (state) => {
			if (state.stage === "reviewing" && state.review && !interrupted) {
				interrupted = true;
				throw new Error("telemetry offline");
			}
		});
		vi.mocked(f.models.review).mockImplementation(async (input) => ({
			conversationId: 3,
			review: {
				...review(input.round),
				verdict: "changes_requested",
				findings: [{ severity: "P2", path: "package.json", message: "fix" }],
			},
		}));
		await expect(createRepairEngine(f.opts).run(candidate)).rejects.toThrow("telemetry offline");
		await harness.close(BACKGROUND_CONTEXT);
		harness = await Harness.open(
			await openNodeSqliteStorage(database),
			{ models: createModels(), registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);
		f = await setup(harness);
		const result = await createRepairEngine(f.opts).run(candidate);
		expect(result.stage).toBe("pushed");
		expect(result.round).toBe(2);
		expect(f.models.plan).not.toHaveBeenCalled();
		expect(f.driver.updateDependency).not.toHaveBeenCalled();
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	}
});
it("validates dependency scope and exact review proof", () => {
	expect(() => assertDependencyPlan(plan, issue, "{}")).toThrow();
	expect(() =>
		assertDependencyPlan(plan, issue, '{"dependencies":{"demo":"1.0.0"}}'),
	).not.toThrow();
	expect(() => assertDependencyPlan(plan, issue, '{"dependencies":{"demo":"3.0.0"}}')).toThrow();
	expect(() =>
		assertDependencyPlan(
			{ ...plan, dependency: "other" },
			issue,
			'{"dependencies":{"other":"1.0.0"}}',
		),
	).toThrow();
	expect(() =>
		assertDependencyPlan({ ...plan, manifest: "nested/package.json" }, issue, "{}"),
	).toThrow();
	expect(() => assertDependencyOutcome(plan, snapshot)).not.toThrow();
	expect(() =>
		assertDependencyOutcome(plan, { ...snapshot, changedPaths: ["package.json"] }),
	).toThrow(/lockfile/);
	expect(() => assertDependencyOutcome(plan, { ...snapshot, manifestBeforeAfter: {} })).toThrow();
	expect(() =>
		assertDependencyOutcome({ ...plan, manifest: "nested/package.json" }, snapshot),
	).toThrow();
	expect(() => assertDependencyOutcome({ ...plan, targetVersion: "3.0.0" }, snapshot)).toThrow();
	expect(() => assertReviewSignoff({ ...review(1), head: sha }, snapshot, checks, 1)).toThrow();
	expect(() => assertReviewSignoff(review(1), snapshot, checks, 1)).not.toThrow();
});

it("does not overlap repairs and respects an already-aborted invocation", async () => {
	const f = await setup();
	let done: () => void = () => {};
	f.admission.mockImplementationOnce(async () => {
		await new Promise<void>((resolve) => {
			done = resolve;
		});
		return { eligible: false, reason: "defer" };
	});
	const { now: _now, ...defaults } = f.opts;
	try {
		const engine = createRepairEngine(defaults);
		expect((await engine.run(candidate, AbortSignal.abort())).stage).toBe("discovered");
		const first = engine.run(candidate);
		await vi.waitFor(() => expect(f.admission).toHaveBeenCalled());
		await expect(engine.run(candidate)).rejects.toThrow(/one dependency/);
		done();
		await first;
		await expect(engine.state("missing")).rejects.toThrow(/missing/);
	} finally {
		await f.harness.close(BACKGROUND_CONTEXT);
	}
});

it("bounds real-time event payload below the API budget", async () => {
	const f = await setup();
	try {
		const engine = createRepairEngine(f.opts);
		const state = await engine.run(candidate, AbortSignal.abort());
		for (let index = 0; index < 35; index++) await engine.trace(state.id, "x".repeat(2000));
		expect(Buffer.byteLength(JSON.stringify(await engine.state(state.id)))).toBeLessThan(60000);
	} finally {
		await f.harness.close(BACKGROUND_CONTEXT);
	}
});

it("retries prerequisite-blocked issues only after local grants change without repeating completed work", async () => {
	const f = await setup();
	try {
		const before = createRepairEngine({
			...f.opts,
			grantVersion: "none",
			prerequisite: () => "Local tools unavailable",
		});
		expect((await before.run(candidate)).stage).toBe("blocked");
		expect(f.verify).not.toHaveBeenCalled();
		const unchanged = createRepairEngine({
			...f.opts,
			grantVersion: "none",
			prerequisite: () => null,
		});
		expect((await unchanged.run(candidate)).stage).toBe("blocked");
		expect(f.verify).not.toHaveBeenCalled();
		const after = createRepairEngine({
			...f.opts,
			grantVersion: "configured",
			prerequisite: () => null,
		});
		expect((await after.run(candidate)).stage).toBe("pushed");
		expect(f.models.work).toHaveBeenCalledOnce();
	} finally {
		await f.harness.close(BACKGROUND_CONTEXT);
	}
});

it("terminates stale candidates without poisoning the frozen cycle or blocking the next issue", async () => {
	const f = await setup();
	f.verify.mockRejectedValueOnce(new LiveStateChanged("Issue closed"));
	try {
		const engine = createRepairEngine(f.opts);
		expect((await engine.run(candidate)).stage).toBe("cancelled");
		expect((await engine.run({ ...candidate, number: 2 })).stage).toBe("pushed");
		expect(f.push).toHaveBeenCalledOnce();
	} finally {
		await f.harness.close(BACKGROUND_CONTEXT);
	}
});

it("cancels an issue changed after review but retries transport failures", async () => {
	for (const error of [new LiveStateChanged("Issue changed"), new Error("transport")]) {
		const f = await setup();
		f.verify.mockResolvedValueOnce(issue).mockRejectedValueOnce(error);
		try {
			const run = createRepairEngine(f.opts).run(candidate);
			if (error instanceof LiveStateChanged) expect((await run).stage).toBe("cancelled");
			else await expect(run).rejects.toThrow("transport");
			expect(f.push).not.toHaveBeenCalled();
		} finally {
			await f.harness.close(BACKGROUND_CONTEXT);
		}
	}
});

it("telemetry failures after successful workspace/install remain resumable not blocked", async () => {
	for (const phase of ["workspace", "install"]) {
		const f = await setup();
		let failed = false;
		f.publish.mockImplementation(async (progress) => {
			if (
				!failed &&
				(phase === "workspace"
					? progress.reason.includes("workspace prepared")
					: progress.reason.includes("lockfile updated"))
			) {
				failed = true;
				throw new Error("telemetry");
			}
		});
		try {
			const engine = createRepairEngine(f.opts);
			await expect(engine.run(candidate)).rejects.toThrow("telemetry");
			const outcome = await engine.run(candidate);
			expect(outcome.stage).toBe("pushed");
			expect(f.driver.updateDependency).toHaveBeenCalledOnce();
		} finally {
			await f.harness.close(BACKGROUND_CONTEXT);
		}
	}
});

it("pause or cancellation arriving during final checks prevents publication", async () => {
	for (const mode of ["pause", "abort"]) {
		const f = await setup();
		const controller = new AbortController();
		let paused = false;
		let checksRun = 0;
		f.check.mockImplementation(async () => {
			if (++checksRun === 3) {
				if (mode === "pause") paused = true;
				else controller.abort();
			}
			return checks;
		});
		try {
			const result = await createRepairEngine({ ...f.opts, isPaused: async () => paused }).run(
				candidate,
				controller.signal,
			);
			expect(result.stage).toBe("pushing");
			expect(f.push).not.toHaveBeenCalled();
		} finally {
			await f.harness.close(BACKGROUND_CONTEXT);
		}
	}
});
it("keeps an interrupted install resumable without consuming another round", async () => {
	const f = await setup();
	const controller = new AbortController();
	vi.mocked(f.driver.updateDependency).mockImplementationOnce(async (_workspace, input) => {
		expect(input.signal).toBe(controller.signal);
		controller.abort();
		throw new WorkspaceError("Repair operation cancelled");
	});
	try {
		const engine = createRepairEngine(f.opts);
		const paused = await engine.run(candidate, controller.signal);
		expect(paused.stage).toBe("fixing");
		expect(paused.round).toBe(1);
		expect(f.models.work).not.toHaveBeenCalled();
		expect(f.push).not.toHaveBeenCalled();
		const result = await engine.run(candidate);
		expect(result.stage).toBe("pushed");
		expect(result.round).toBe(1);
		expect(f.driver.updateDependency).toHaveBeenCalledTimes(2);
	} finally {
		await f.harness.close(BACKGROUND_CONTEXT);
	}
});
it.each(["prepare", "updateDependency", "check", "commit", "push"] as const)(
	"blocks for operator intervention after %s process cleanup failure",
	async (method) => {
		const f = await setup();
		vi.mocked(f.driver[method]).mockRejectedValueOnce(new LocalCleanupError());
		try {
			const engine = createRepairEngine(f.opts);
			const state = await engine.run(candidate);
			expect(state.stage).toBe("blocked");
			expect(state.reason).toContain("operator intervention");
			expect((await engine.run(candidate)).stage).toBe("blocked");
			expect(f.driver[method]).toHaveBeenCalledOnce();
		} finally {
			await f.harness.close(BACKGROUND_CONTEXT);
		}
	},
);
