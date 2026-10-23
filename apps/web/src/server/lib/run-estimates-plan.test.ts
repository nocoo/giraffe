import { describe, expect, it } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { type FactoryRun, type FactoryRunStep, makeRun } from "../../lib/factory-run";
import { createDb } from "./db/d1";
import { estimateRunFinish, readRunEstimates } from "./run-estimates";

const now = "2026-10-22T00:00:00.000Z";
const started = Date.parse(now);
const stamp = (milliseconds: number) => new Date(started + milliseconds).toISOString();
const base = makeRun("base", "a", "owner", "base", "catalog", [], now).steps[0] as FactoryRunStep;
const step = (kind: FactoryRunStep["kind"], durationMs = 0): FactoryRunStep => ({
	...base,
	kind,
	status: "success",
	attempts: 1,
	durationMs,
});

async function history(
	steps: FactoryRunStep[],
	durationMs: number,
	depth: "quick" | "deep",
	trigger: "daily" | "manual" = "daily",
) {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','encrypted','fake',?,?)",
		)
		.bind(now, now)
		.run();
	const run = {
		...makeRun("history", "a", "owner", "history", "refresh", [], now),
		depth,
		trigger,
		selection: { scope: trigger === "manual" ? "selected" : "all" },
		status: "partial",
		steps,
		finishedAt: stamp(durationMs),
	};
	await raw
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('history','a','history','partial',?,?,?,?)",
		)
		.bind(JSON.stringify(run), now, now, now)
		.run();
	return readRunEstimates(createDb(raw), "a");
}

describe("plan-scaled finish estimates", () => {
	it.each(["quick", "deep"] as const)(
		"scales a 55-step manual selected %s run down from a large daily sample, including wall overhead",
		async (depth) => {
			const calibration = await history(
				[
					...Array.from({ length: 100 }, () => step("metadata", 1000)),
					...Array.from({ length: 1000 }, () => step("snapshot", 3000)),
				],
				4_200_000,
				depth,
			);
			const steps = [
				...Array.from({ length: 5 }, () => step("metadata")),
				...Array.from({ length: 50 }, () => step("snapshot")),
			].map((entry) => ({ ...entry, status: "pending" as const }));
			const run: FactoryRun = {
				...makeRun("manual", "a", "owner", "manual", "refresh", [], now),
				depth,
				trigger: "manual",
				selection: { scope: "selected", repos: ["owner/app"] },
				steps,
			};
			expect(estimateRunFinish(run, 55, calibration, now)).toEqual({
				expectedFinishAt: stamp(210_000),
				expectedFinishAtReason: null,
			});
		},
	);

	it("scales a large daily plan up from small manual history and falls back to the overall step median", async () => {
		const calibration = await history(
			[step("metadata", 1000), step("snapshot", 3000), step("snapshot", 5000)],
			12_000,
			"quick",
			"manual",
		);
		const run = {
			...makeRun("daily", "a", "owner", "daily", "refresh", [], now),
			depth: "quick" as const,
			trigger: "daily" as const,
			steps: Array.from({ length: 1200 }, () => ({
				...step("activity"),
				status: "pending" as const,
			})),
		};
		expect(estimateRunFinish(run, 1200, calibration, now).expectedFinishAt).toBe(stamp(4_800_000));
	});

	it("removes every terminal outcome, including skipped future work, and honors outstanding backoff", async () => {
		const calibration = await history(
			[step("metadata", 1000), step("snapshot", 3000)],
			6000,
			"quick",
		);
		const statuses = [
			"success",
			"failed",
			"unavailable",
			"limited",
			"skipped",
			"pending",
			"running",
		] as const;
		const run = {
			...makeRun("active", "a", "owner", "active", "refresh", [], now),
			depth: "quick" as const,
			cursor: 1,
			nextAttemptAt: stamp(60_000),
			steps: statuses.map((status) => ({ ...step("snapshot"), status })),
		};
		for (const status of ["running", "paused"] as const)
			expect(estimateRunFinish({ ...run, status }, 7, calibration, stamp(30_000))).toEqual({
				expectedFinishAt: stamp(68_000),
				expectedFinishAtReason: null,
			});
		expect(estimateRunFinish(run, 7, calibration, stamp(90_000)).expectedFinishAt).toBe(
			stamp(98_000),
		);
	});

	it("does not learn duration or overhead from skipped, unexecuted or invalid timing fields", async () => {
		const missingDuration = { ...step("snapshot") } as Partial<FactoryRunStep>;
		delete missingDuration.durationMs;
		const calibration = await history(
			[
				step("metadata", 1000),
				{ ...step("metadata", 999999), status: "skipped" },
				{ ...step("snapshot", 0), attempts: 0 },
				step("snapshot", -1),
				{ ...step("snapshot"), durationMs: "1000" as unknown as number },
				missingDuration as FactoryRunStep,
			],
			60_000,
			"deep",
		);
		const run = {
			mode: "refresh" as const,
			startedAt: now,
			steps: [{ ...step("snapshot"), status: "pending" as const }],
		};
		expect(estimateRunFinish(run, 1, calibration).expectedFinishAt).toBe(stamp(1000));
	});

	it("normalizes historical wall time by non-skipped plan size when no audited step timings exist", async () => {
		const calibration = await history(
			[
				{ ...step("metadata"), attempts: 0 },
				{ ...step("snapshot"), attempts: 0 },
				{ ...step("snapshot"), status: "skipped" },
			],
			60_000,
			"quick",
		);
		expect(calibration.quick).toBe(30_000);
		expect(
			estimateRunFinish({ mode: "refresh", depth: "quick", startedAt: now }, 10, calibration)
				.expectedFinishAt,
		).toBe(stamp(300_000));
	});

	it("never learns a wall duration from an entirely skipped plan", async () => {
		const calibration = await history(
			[{ ...step("metadata"), status: "skipped" }],
			60_000,
			"quick",
		);
		expect(
			estimateRunFinish({ mode: "refresh", depth: "quick", startedAt: now }, 10, calibration),
		).toEqual({
			expectedFinishAt: null,
			expectedFinishAtReason: "no_completed_history",
		});
	});

	it("keeps genuine zero timings without treating missing duration as measured zero", async () => {
		const calibration = await history([step("metadata", 0), step("snapshot", 2000)], 4000, "deep");
		const run = { mode: "refresh" as const, startedAt: now, steps: [step("metadata")] };
		expect(estimateRunFinish(run, 1, calibration).expectedFinishAt).toBe(stamp(1000));
	});

	it("averages the middle step-kind timings and never subtracts negative wall overhead", async () => {
		const calibration = await history(
			[step("metadata", 1000), step("metadata", 3000), step("snapshot", 10_000)],
			10_000,
			"deep",
		);
		expect(calibration.stepKinds?.deep?.metadata).toBe(2000);
		expect(calibration.deep).toBe(3000);
		expect(calibration.overhead?.deep).toBe(0);
		expect(
			estimateRunFinish(
				{ mode: "refresh", startedAt: now, steps: [step("metadata")] },
				1,
				calibration,
			).expectedFinishAt,
		).toBe(stamp(2000));
	});
});
