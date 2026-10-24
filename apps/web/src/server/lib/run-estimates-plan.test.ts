import { describe, expect, it } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { type FactoryRun, type FactoryRunStep, makeRun } from "../../lib/factory-run";
import { createDb } from "./db/d1";
import { estimateRunFinish, type RunStepPlan, readRunEstimates } from "./run-estimates";

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
	it("models the 06:44 activity entry tail instead of spreading its waits over factory steps", async () => {
		const timed = (
			kind: FactoryRunStep["kind"],
			repo: string | null,
			start: number,
			wall: number,
			service: number,
		) => ({
			...step(kind, service),
			repo,
			startedAt: stamp(start),
			finishedAt: stamp(start + wall),
		});
		const factoryStart = 108_000;
		const snapshotStart = factoryStart + 816_000;
		const activityStart = snapshotStart + 837_000;
		const activityEnd = activityStart + 858_000;
		const steps = [
			timed("snapshot", null, 0, factoryStart, 62_000),
			...Array.from({ length: 540 }, (_, index) =>
				timed(
					"metadata",
					`r${Math.floor(index / 9)}`,
					factoryStart + Math.floor(index / 36) * (816_000 / 15) + (index % 9) * (816_000 / 135),
					816_000 / 135,
					1_737_000 / 540,
				),
			),
			...Array.from({ length: 540 }, (_, index) =>
				timed(
					"snapshot",
					`r${Math.floor(index / 9)}`,
					snapshotStart + Math.floor(index / 36) * (837_000 / 15) + (index % 9) * (837_000 / 135),
					837_000 / 135,
					1_889_000 / 540,
				),
			),
			...Array.from({ length: 60 }, (_, index) =>
				timed("activity", `r${index}`, activityStart + index * 14_300, 14_300, 299_000 / 60),
			),
			{ ...timed("snapshot", null, activityEnd, 3000, 3000), resource: "insights" },
			timed("publish", null, activityEnd + 3000, 4000, 4000),
		];
		const finish = activityEnd + 7000;
		const calibration = await history(steps, finish, "quick");
		expect(calibration.plans?.history?.at(-2)).toEqual(["snapshot", 1, 0, null, "insights"]);
		const dailyStart = "2026-10-24T06:14:55+08:00";
		const current = new Date(Date.parse(dailyStart) + activityStart).toISOString();
		const expected = new Date(Date.parse(dailyStart) + finish).toISOString();
		const pending = steps.map((entry) => ({
			...entry,
			status:
				entry.kind === "activity" || entry.kind === "publish" || entry.resource === "insights"
					? ("pending" as const)
					: ("success" as const),
		}));
		const run = {
			mode: "refresh" as const,
			depth: "quick" as const,
			status: "running" as const,
			startedAt: dailyStart,
			steps: pending,
		};
		expect(current).toBe("2026-10-23T22:44:16.000Z");
		const detailed = estimateRunFinish(run, steps.length, calibration, current);
		expect(Date.parse(detailed.expectedFinishAt ?? "")).toBeGreaterThanOrEqual(
			Date.parse(expected),
		);
		expect(Date.parse(detailed.expectedFinishAt ?? "") - Date.parse(expected)).toBeLessThan(60_000);
		const stepPlan: RunStepPlan = pending.map(({ kind, repo, status, resource }) =>
			resource === "insights"
				? [kind, 1, Number(status === "pending"), repo, resource]
				: [kind, 1, Number(status === "pending"), repo],
		);
		expect(
			estimateRunFinish({ ...run, steps: [], stepPlan }, steps.length, calibration, current),
		).toEqual(detailed);
		const initial = steps.map((entry) => ({ ...entry, status: "pending" as const }));
		expect(
			Date.parse(
				estimateRunFinish({ ...run, steps: initial }, steps.length, calibration, dailyStart)
					.expectedFinishAt ?? "",
			),
		).toBeGreaterThanOrEqual(Date.parse(expected));
	});

	it.each([
		["invalid", stamp(1000)],
		[stamp(2000), stamp(1000)],
		[stamp(-1), stamp(1000)],
		[stamp(0), stamp(5000)],
	] as const)(
		"rejects invalid phase envelopes %s to %s without losing aggregate calibration",
		async (startedAt, finishedAt) => {
			const calibration = await history(
				[{ ...step("metadata", 1000), startedAt, finishedAt }],
				3000,
				"quick",
			);
			expect(calibration.phaseOverhead).toBeUndefined();
			expect(calibration.overhead?.quick).toBe(2000);
		},
	);

	it("assigns delivery and terminal gaps to their actual phases and accepts zero-duration work", async () => {
		const steps = [
			{ ...step("contributions", 0), repo: null, startedAt: stamp(1000), finishedAt: stamp(1000) },
			{ ...step("activity", 1000), repo: "r", startedAt: stamp(2000), finishedAt: stamp(5000) },
			{ ...step("publish", 1000), repo: null, startedAt: stamp(6000), finishedAt: stamp(7000) },
		];
		const calibration = await history(steps, 8000, "quick");
		expect(calibration.phaseOverhead?.quick).toEqual({
			account: 1000,
			activity: 3000,
			publish: 2000,
		});
		expect(
			estimateRunFinish(
				{
					mode: "refresh",
					depth: "quick",
					startedAt: now,
					status: "running",
					steps: steps.map((entry) => ({ ...entry, status: "pending" })),
				},
				steps.length,
				calibration,
				now,
			).expectedFinishAt,
		).toBe(stamp(8000));
	});

	it("does not spread account prelude and insights waits across repository work", async () => {
		const steps = [
			{ ...step("snapshot", 10_000), repo: null, startedAt: stamp(0), finishedAt: stamp(100_000) },
			...Array.from({ length: 4 }, (_, index) => ({
				...step("metadata", 1000),
				repo: `r${index}`,
				startedAt: stamp(100_000),
				finishedAt: stamp(101_000),
			})),
			{
				...step("snapshot", 1000),
				repo: null,
				resource: "insights",
				startedAt: stamp(103_000),
				finishedAt: stamp(104_000),
			},
			{
				...step("publish", 1000),
				repo: null,
				startedAt: stamp(104_000),
				finishedAt: stamp(105_000),
			},
		];
		const calibration = await history(steps, 105_000, "quick");
		const run = {
			mode: "refresh" as const,
			depth: "quick" as const,
			startedAt: now,
			status: "running" as const,
			steps: steps.map((entry) => ({
				...entry,
				status: entry.repo ? ("pending" as const) : ("success" as const),
			})),
		};
		expect(estimateRunFinish(run, steps.length, calibration, stamp(100_000)).expectedFinishAt).toBe(
			stamp(101_000),
		);
		expect(
			estimateRunFinish(
				{
					...run,
					steps: steps.map((entry) => ({
						...entry,
						status:
							entry.repo || entry.kind === "snapshot" ? ("success" as const) : ("pending" as const),
					})),
				},
				steps.length,
				calibration,
				stamp(104_000),
			).expectedFinishAt,
		).toBe(stamp(105_000));
	});

	it("keeps rolling four-repo lanes, separate phases, deferred activity and serial overhead", () => {
		const steps = [
			...Array.from({ length: 9 }, () => ({ ...step("metadata"), repo: "r0" })),
			...Array.from({ length: 4 }, (_, index) => ({ ...step("metadata"), repo: `r${index + 1}` })),
			...Array.from({ length: 5 }, (_, index) => [
				{ ...step("snapshot"), repo: `r${index}` },
				...(index < 2 ? [{ ...step("activity"), repo: `r${index}` }] : []),
			]).flat(),
			step("publish"),
		].map((entry) => ({ ...entry, status: "pending" as const }));
		const run = { mode: "refresh" as const, startedAt: now, status: "running" as const, steps };
		const calibration = {
			catalog: null,
			quick: null,
			deep: 1000,
			stepKinds: { deep: { metadata: 1000, snapshot: 3000, activity: 5000, publish: 7000 } },
			overhead: { deep: 500 },
		};
		expect(estimateRunFinish(run, steps.length, calibration, now).expectedFinishAt).toBe(
			stamp(42_500),
		);
	});

	it("excludes terminal repo work before assigning remaining repositories to lanes", () => {
		const steps = [
			...Array.from({ length: 4 }, (_, index) => ({ ...step("metadata"), repo: `done${index}` })),
			...Array.from({ length: 5 }, (_, index) => ({
				...step("metadata"),
				repo: `todo${index}`,
				status: index === 0 ? ("running" as const) : ("pending" as const),
			})),
		];
		const run = {
			mode: "refresh" as const,
			startedAt: now,
			status: "paused" as const,
			nextAttemptAt: stamp(60_000),
			steps,
		};
		expect(
			estimateRunFinish(
				run,
				steps.length,
				{ catalog: null, quick: null, deep: 1000, stepKinds: { deep: {} } },
				now,
			).expectedFinishAt,
		).toBe(stamp(62_000));
	});

	it("overlaps long A and E in detailed and compact remaining-work plans after backoff", () => {
		const steps = [
			...(["success", "failed", "unavailable", "limited", "skipped"] as const).map(
				(status, index) => ({ ...step("issues"), repo: `done${index}`, status }),
			),
			{ ...step("issues"), repo: "a", status: "running" as const },
			...["b", "c", "d"].map((repo) => ({
				...step("metadata"),
				repo,
				status: "pending" as const,
			})),
			{ ...step("issues"), repo: "e", status: "pending" as const },
		];
		const stepPlan: RunStepPlan = steps.map(({ kind, status, repo }) => [
			kind,
			Number(status !== "skipped"),
			Number(status === "pending" || status === "running"),
			repo,
		]);
		const run = {
			mode: "refresh" as const,
			startedAt: now,
			status: "running" as const,
			nextAttemptAt: stamp(60_000),
			steps,
		};
		const calibration = {
			catalog: null,
			quick: null,
			deep: 1000,
			stepKinds: { deep: { metadata: 1000, issues: 10_000 } },
			overhead: { deep: 500 },
		};
		const detailed = estimateRunFinish(run, steps.length, calibration, stamp(30_000));
		expect(detailed.expectedFinishAt).toBe(stamp(73_500));
		expect(
			estimateRunFinish({ ...run, steps: [], stepPlan }, steps.length, calibration, stamp(30_000)),
		).toEqual(detailed);
	});

	it("calibrates invocation-boundary delay separately from rolling A/E service time", async () => {
		const steps = [
			{ ...step("issues", 10_000), repo: "a" },
			...["b", "c", "d"].map((repo) => ({ ...step("metadata", 1000), repo })),
			{ ...step("issues", 10_000), repo: "e" },
		];
		const calibration = await history(steps, 14_000, "deep");
		expect(calibration.overhead?.deep).toBe(600);
		const run = {
			id: "history",
			mode: "refresh" as const,
			startedAt: now,
			status: "completed" as const,
			steps,
		};
		const detailed = estimateRunFinish(run, steps.length, calibration, now);
		expect(detailed).toEqual({ expectedFinishAt: null, expectedFinishAtReason: "terminal" });
		expect(
			estimateRunFinish({ mode: "refresh", startedAt: now, steps }, steps.length, calibration)
				.expectedFinishAt,
		).toBe(stamp(14_000));
		expect(estimateRunFinish({ ...run, steps: [] }, steps.length, calibration, now)).toEqual(
			detailed,
		);
	});

	it("preserves repo lane order and deferred activities in compact plans", async () => {
		const steps = [
			...Array.from({ length: 5 }, (_, index) => ({
				...step("metadata", 1000),
				repo: `r${index}`,
			})),
			...Array.from({ length: 5 }, (_, index) => [
				{ ...step("snapshot", 3000), repo: `r${index}` },
				{ ...step("snapshot", 3000), repo: `r${index}` },
				{ ...step("activity", 5000), repo: `r${index}` },
			]).flat(),
			step("publish", 7000),
		];
		const calibration = await history(steps, 48_000, "deep");
		const run = {
			id: "history",
			mode: "refresh" as const,
			startedAt: now,
			status: "completed" as const,
			steps,
		};
		expect(calibration.plans?.history?.slice(0, 2)).toEqual([
			["metadata", 1, 0, "r0"],
			["metadata", 1, 0, "r1"],
		]);
		expect(estimateRunFinish({ ...run, steps: [] }, steps.length, calibration, now)).toEqual(
			estimateRunFinish(run, steps.length, calibration, now),
		);
		expect(estimateRunFinish(run, steps.length, calibration, now)).toEqual({
			expectedFinishAt: null,
			expectedFinishAtReason: "terminal",
		});
		expect(
			estimateRunFinish(
				{ id: run.id, mode: "refresh", startedAt: now, steps: [] },
				steps.length,
				calibration,
			).expectedFinishAt,
		).toBe(stamp(48_000));
	});

	it("learns serial overhead from parallel wall time rather than summed request service time", async () => {
		const calibration = await history(
			Array.from({ length: 4 }, (_, index) => ({ ...step("metadata", 1000), repo: `r${index}` })),
			3000,
			"deep",
		);
		expect(calibration.overhead?.deep).toBe(500);
		expect(
			estimateRunFinish(
				{
					mode: "refresh",
					startedAt: now,
					steps: Array.from({ length: 4 }, (_, index) => ({
						...step("metadata"),
						repo: `r${index}`,
					})),
				},
				4,
				calibration,
			).expectedFinishAt,
		).toBe(stamp(3000));
	});

	it("does not discount already wall-normalized history again when audited step timing is absent", async () => {
		const calibration = await history(
			Array.from({ length: 4 }, (_, index) => ({
				...step("metadata"),
				attempts: 0,
				repo: `r${index}`,
			})),
			4000,
			"deep",
		);
		const steps = Array.from({ length: 4 }, (_, index) => ({
			...step("metadata"),
			repo: `r${index}`,
		}));
		expect(
			estimateRunFinish({ mode: "refresh", startedAt: now, steps }, 4, calibration)
				.expectedFinishAt,
		).toBe(stamp(4000));
	});
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
