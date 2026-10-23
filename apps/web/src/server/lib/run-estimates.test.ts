import { describe, expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { type FactoryRun, makeRun } from "../../lib/factory-run";
import { createDb } from "./db/d1";
import {
	decodeRunEstimates,
	estimateRunFinish,
	type RunEstimateRow,
	type RunStepPlan,
	readRunEstimates,
	runEstimateStatement,
} from "./run-estimates";

const now = "2026-10-22T00:00:00.000Z";
const stamp = (value: number) => new Date(value).toISOString();
const started = Date.parse(now);
const empty = { catalog: null, quick: null, deep: null };

async function fixture() {
	const raw = sqliteFixture();
	for (const account of ["a", "b"])
		await raw
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?,?,?,?,?)",
			)
			.bind(account, account, "encrypted", "fake", now, now)
			.run();
	async function seed(id: string, input: Partial<FactoryRun> = {}) {
		const run: FactoryRun = {
			...makeRun(id, "a", "owner", id, "refresh", [], now),
			status: "completed",
			finishedAt: stamp(started + 1000),
			...input,
		};
		await raw
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
			)
			.bind(
				run.id,
				run.account_id,
				run.requestKey,
				run.status,
				JSON.stringify(run),
				run.startedAt,
				run.startedAt,
				run.startedAt,
			)
			.run();
		return run;
	}
	return { raw, seed };
}

describe("historical run calibration", () => {
	it.each([
		{ durations: [], median: null },
		{ durations: [1200], median: 1200 },
		{ durations: [1001, 2000], median: 1500.5 },
		{ durations: [90000, 1000, 2000, 3000], median: 2500 },
		{ durations: [100000, 1000, 2000, 3000, 4000], median: 3000 },
		{ durations: [0], median: 0 },
	])("uses the median of $durations", ({ durations, median }) => {
		expect(
			decodeRunEstimates(
				durations.map((duration) => ({
					kind: "deep",
					started_at: now,
					finished_at: stamp(started + duration),
					total: 1,
					work_total: 1,
					timed_total: 0,
					timed_steps: "[]",
					step_medians: null,
					plans: null,
				})),
			),
		).toEqual({ ...empty, deep: median });
	});

	it("reads each account's latest five valid samples across all retained history", async () => {
		const { raw, seed } = await fixture();
		for (const [index, duration] of [500000, 10000, 20000, 30000, 40000, 60000].entries()) {
			const start = started - (10 - index) * 86400000;
			await seed(`deep-${index}`, {
				startedAt: stamp(start),
				finishedAt: stamp(start + duration),
				...(index % 2 === 0 ? { depth: "deep" } : {}),
			});
			if (index % 2 !== 0)
				await raw
					.prepare("UPDATE factory_runs SET payload=json_remove(payload,'$.depth') WHERE id=?")
					.bind(`deep-${index}`)
					.run();
		}
		for (let index = 0; index < 25; index++)
			await seed(`recent-failed-${index}`, { status: "failed" });
		for (const status of ["paused", "cancelled"] as const) await seed(status, { status });
		for (const [index, input] of [
			{ startedAt: "invalid" },
			{ finishedAt: "invalid" },
			{ startedAt: stamp(started + 5000), finishedAt: now },
			{ finishedAt: null },
			{ steps: [], finishedAt: now },
			{ steps: [], error: "scheduled_slot_missed" },
		].entries())
			await seed(`invalid-${index}`, input);
		await seed("quick", { depth: "quick", finishedAt: stamp(started + 100000) });
		await seed("daily-catalog", {
			mode: "catalog",
			depth: "quick",
			trigger: "daily",
			finishedAt: stamp(started + 400000),
		});
		await seed("weekly-catalog", {
			mode: "catalog",
			trigger: "weekly",
			finishedAt: stamp(started + 600000),
		});
		await seed("other-account", { account_id: "b", finishedAt: stamp(started + 777) });
		const before = await raw.prepare("SELECT * FROM factory_runs ORDER BY id").all();
		const db = createDb(raw);
		const batch = vi.spyOn(db, "batch");
		const result = await db.batch<RunEstimateRow>([runEstimateStatement(db, "a")]);
		expect(batch).toHaveBeenCalledTimes(1);
		expect(db.statements).toBe(1);
		expect(result[0]?.results).toHaveLength(8);
		for (const row of result[0]?.results ?? []) {
			expect(row).toHaveProperty("total");
			expect(row).toHaveProperty("work_total");
			expect(row).not.toHaveProperty("payload");
		}
		expect(decodeRunEstimates(result[0]?.results ?? [])).toEqual({
			catalog: 62500,
			quick: 12500,
			deep: 3750,
			plans: expect.any(Object),
		});
		expect(await readRunEstimates(createDb(raw), "b")).toEqual({
			...empty,
			deep: 777 / 8,
			plans: expect.any(Object),
		});
		expect(await readRunEstimates(createDb(raw), "missing")).toEqual(empty);
		expect(await raw.prepare("SELECT * FROM factory_runs ORDER BY id").all()).toEqual(before);
	});

	it("calibrates from the latest five positive-work partial runs without failed or cancelled samples", async () => {
		const { raw, seed } = await fixture();
		for (const [index, duration] of [500000, 10000, 20000, 30000, 40000, 60000].entries()) {
			const start = started - (10 - index) * 86400000;
			await seed(`partial-${index}`, {
				status: "partial",
				startedAt: stamp(start),
				finishedAt: stamp(start + duration),
			});
		}
		for (const status of ["failed", "cancelled"] as const)
			await seed(status, { status, finishedAt: stamp(started + 999000) });
		await seed("partial-audit", { status: "partial", steps: [] });
		await seed("partial-unfinished", { status: "partial", finishedAt: null });
		await seed("partial-invalid", { status: "partial", finishedAt: "invalid" });
		await seed("partial-reversed", { status: "partial", finishedAt: stamp(started - 1000) });
		await seed("other-account-partial", { status: "partial", account_id: "b" });
		const before = await raw.prepare("SELECT * FROM factory_runs ORDER BY id").all();
		expect(await readRunEstimates(createDb(raw), "a")).toEqual({
			...empty,
			deep: 3750,
			plans: expect.any(Object),
		});
		expect(await raw.prepare("SELECT * FROM factory_runs ORDER BY id").all()).toEqual(before);
	});

	it("combines completed and partial work but leaves uncalibrated kinds explicitly unavailable", async () => {
		const { raw, seed } = await fixture();
		await seed("completed", { finishedAt: stamp(started + 10000) });
		await seed("partial", { status: "partial", finishedAt: stamp(started + 30000) });
		const calibration = await readRunEstimates(createDb(raw), "a");
		expect(calibration).toEqual({ ...empty, deep: 2500, plans: expect.any(Object) });
		expect(
			estimateRunFinish({ mode: "refresh", depth: "quick", startedAt: now }, 1, calibration),
		).toEqual({ expectedFinishAt: null, expectedFinishAtReason: "no_completed_history" });
	});

	it("breaks finish-time ties by descending ID before taking five samples", async () => {
		const { raw, seed } = await fixture();
		for (const [index, id] of ["a", "b", "c", "d", "e", "f"].entries())
			await seed(id, { startedAt: stamp(started - (index + 1) * 1000), finishedAt: now });
		expect(await readRunEstimates(createDb(raw), "a")).toEqual({
			...empty,
			deep: 500,
			plans: expect.any(Object),
		});
	});

	it("keeps a genuine zero-duration completed run but rejects zero-work audits", async () => {
		const { raw, seed } = await fixture();
		await seed("zero", { finishedAt: now });
		await seed("audit", { steps: [], finishedAt: stamp(started + 10000) });
		expect(await readRunEstimates(createDb(raw), "a")).toEqual({
			...empty,
			deep: 0,
			plans: expect.any(Object),
		});
	});

	it.each([
		"2026-10-22T24:00:00.001Z",
		"2026-10-22T00:00:00 Z",
		"2026-10-22T00:00:00 +00:00",
		"2026-10-22T00:00:00Z ",
		"2026-10-22T00:00:00Z\n",
	])("rejects SQLite-only timestamp %j before selecting the latest five", async (invalid) => {
		const { raw, seed } = await fixture();
		expect(Number.isNaN(Date.parse(invalid))).toBe(true);
		await seed("valid", { finishedAt: stamp(started + 10000) });
		for (let index = 0; index < 6; index++)
			await seed(`invalid-hour-${index}`, {
				startedAt: invalid,
				finishedAt: "2026-10-23T01:00:00.000Z",
			});
		expect(await readRunEstimates(createDb(raw), "a")).toEqual({
			...empty,
			deep: 1250,
			plans: expect.any(Object),
		});
	});

	it("accepts ISO timestamps with UTC offsets and optional fractional seconds", async () => {
		const { raw, seed } = await fixture();
		await seed("offset", {
			startedAt: "2026-10-22T04:00:00.000+04:00",
			finishedAt: "2026-10-22T00:00:10Z",
		});
		expect(await readRunEstimates(createDb(raw), "a")).toEqual({
			...empty,
			deep: 1250,
			plans: expect.any(Object),
		});
	});

	it("can omit history plans for the scalar latest reader without changing calibration", async () => {
		const { raw, seed } = await fixture();
		await seed("sample", { finishedAt: stamp(started + 8000) });
		const result = await runEstimateStatement(createDb(raw), "a", false).all<RunEstimateRow>();
		expect(result.results).toHaveLength(1);
		expect(result.results[0]?.plans).toBeNull();
		expect(decodeRunEstimates(result.results)).toEqual({ ...empty, deep: 1000 });
	});

	it("groups stored kinds and remaining statuses exactly without counting skipped work or crossing accounts", async () => {
		const { raw, seed } = await fixture();
		const base = makeRun("plan", "a", "owner", "plan", "catalog", [], now).steps[0];
		if (!base) throw new Error("missing fixture step");
		await seed("sample", {
			steps: [
				{ ...base, kind: "metadata", status: "success" },
				{ ...base, kind: "metadata", status: "skipped" },
				{ ...base, kind: "snapshot", status: "pending" },
			],
		});
		await seed("foreign", { account_id: "b" });
		expect(await readRunEstimates(createDb(raw), "a")).toEqual({
			...empty,
			deep: 500,
			plans: {
				sample: [
					["metadata", 1, 0, null],
					["snapshot", 1, 1, null],
				],
			},
		});
	});
});

describe("run finish projection", () => {
	const run = { mode: "refresh", startedAt: now } as const;

	it.each(["completed", "partial", "failed", "cancelled"] as const)(
		"does not project a future finish for terminal %s runs",
		(status) => {
			for (const total of [0, 10]) {
				expect(estimateRunFinish({ ...run, status, startedAt: "invalid" }, total, empty)).toEqual({
					expectedFinishAt: null,
					expectedFinishAtReason: "terminal",
				});
				expect(estimateRunFinish({ ...run, status }, total, { ...empty, deep: 1000 })).toEqual({
					expectedFinishAt: null,
					expectedFinishAtReason: "terminal",
				});
			}
		},
	);

	it("always emits nullable fields with an explicit unavailable reason", () => {
		expect(estimateRunFinish(run, 1, empty)).toEqual({
			expectedFinishAt: null,
			expectedFinishAtReason: "no_completed_history",
		});
		expect(estimateRunFinish({ ...run, startedAt: "invalid" }, 1, empty)).toEqual({
			expectedFinishAt: null,
			expectedFinishAtReason: "invalid_started_at",
		});
		expect(estimateRunFinish({ ...run, startedAt: "invalid" }, 0, empty)).toEqual({
			expectedFinishAt: null,
			expectedFinishAtReason: "not_executed",
		});
	});

	it("uses stored totals rather than stripped steps and classifies actual kind", () => {
		const compact = { ...run, steps: [], depth: "quick" } as const;
		const calibration = { catalog: 5000, quick: 2000, deep: 3000 };
		expect(estimateRunFinish(compact, 10, calibration)).toEqual({
			expectedFinishAt: stamp(started + 20000),
			expectedFinishAtReason: null,
		});
		expect(estimateRunFinish({ ...compact, mode: "catalog" }, 4, calibration)).toEqual({
			expectedFinishAt: stamp(started + 20000),
			expectedFinishAtReason: null,
		});
		expect(estimateRunFinish(run, 10, calibration).expectedFinishAt).toBe(stamp(started + 30000));
	});

	it("does not slide a past estimate or replace it with an independent deadline", () => {
		const old = {
			...run,
			startedAt: "2026-10-01T00:00:00.000Z",
			deadlineAt: "2026-10-01T12:00:00.000Z",
		};
		expect(estimateRunFinish(old, 3, { ...empty, deep: 10000 })).toEqual({
			expectedFinishAt: "2026-10-01T00:00:30.000Z",
			expectedFinishAtReason: null,
		});
		expect(estimateRunFinish(old, 3, empty).expectedFinishAt).toBeNull();
		expect(estimateRunFinish(run, 3, { ...empty, deep: 0 }).expectedFinishAt).toBe(now);
	});

	it("uses grouped remaining kinds for latest/compact projections without transferring steps", () => {
		const stepPlan: RunStepPlan = [
			["metadata", 2, 0, null],
			["snapshot", 2, 1, null],
		];
		const calibration = {
			...empty,
			deep: 2000,
			stepKinds: { deep: { metadata: 1000, snapshot: 3000 } },
			overhead: { deep: 500 },
		};
		expect(estimateRunFinish({ ...run, status: "running", stepPlan }, 4, calibration, now)).toEqual(
			{ expectedFinishAt: stamp(started + 3500), expectedFinishAtReason: null },
		);
		expect(
			estimateRunFinish({ ...run, status: "completed", stepPlan }, 4, calibration, now),
		).toEqual({ expectedFinishAt: null, expectedFinishAtReason: "terminal" });
	});

	it("scales minimal projections by remaining counts, with the cursor only as a last resort", () => {
		const calibration = { ...empty, deep: 1000 };
		for (const [input, remaining] of [
			[{ cursor: 3 }, 7],
			[{ cursor: 3, completed: 8 }, 2],
			[{}, 10],
			[{ completed: 20 }, 0],
		] as const) {
			expect(
				estimateRunFinish({ ...run, status: "running", ...input }, 10, calibration, now)
					.expectedFinishAt,
			).toBe(stamp(started + remaining * 1000));
		}
		expect(
			estimateRunFinish(
				{ ...run, status: "running", nextAttemptAt: "invalid" },
				1,
				calibration,
				now,
			).expectedFinishAt,
		).toBe(stamp(started + 1000));
	});
});
