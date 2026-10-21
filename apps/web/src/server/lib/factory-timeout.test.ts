import { afterEach, expect, it, vi } from "vitest";
import { makeRun } from "../../lib/factory-run";
import { runDeadlineAt, timedOutRun } from "./factory-timeout";

const started = "2026-10-16T11:30:00.000Z";
afterEach(() => vi.useRealTimers());

it.each([
	["catalog", "deep", 30 * 60_000],
	["refresh", "quick", 6 * 3600_000],
	["refresh", "deep", 12 * 3600_000],
] as const)("bounds %s/%s by wall time, including paused runs", (mode, depth, bound) => {
	vi.useFakeTimers();
	vi.setSystemTime(started);
	const run = makeRun("timeout", "account", "owner", "key", mode, [], started);
	run.depth = depth;
	run.status = "paused";
	expect(runDeadlineAt(run)).toBe(new Date(Date.now() + bound).toISOString());
	vi.advanceTimersByTime(bound - 1);
	expect(timedOutRun(run, new Date().toISOString())).toBeNull();
	vi.advanceTimersByTime(1);
	expect(timedOutRun(run, new Date().toISOString())).toMatchObject({
		status: "failed",
		error: "run_timed_out",
		deadlineAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
	});
	expect(run.status).toBe("paused");
});

it("derives legacy deep deadlines and never lets stored deadlines extend the bound", () => {
	const run = makeRun("legacy", "account", "owner", "key", "refresh", [], started);
	delete run.depth;
	expect(runDeadlineAt(run)).toBe("2026-10-16T23:30:00.000Z");
	run.deadlineAt = "2026-10-18T00:00:00.000Z";
	expect(runDeadlineAt(run)).toBe("2026-10-16T23:30:00.000Z");
	run.deadlineAt = "2026-10-16T12:00:00.000Z";
	expect(runDeadlineAt(run)).toBe(run.deadlineAt);
	run.status = "completed";
	expect(timedOutRun(run, "2026-10-19T00:00:00.000Z")).toBeNull();
});

it("fails the in-flight step, skips pending work and preserves completed evidence", () => {
	const run = makeRun("timeout", "account", "owner", "key", "catalog", [], started);
	Object.assign(run.steps[0] ?? {}, { status: "success", error: null });
	Object.assign(run.steps[1] ?? {}, { status: "running", startedAt: started });
	const result = timedOutRun(run, "2026-10-16T12:00:00.000Z");
	expect(result?.steps.map((step) => [step.status, step.error])).toEqual([
		["success", null],
		["failed", "run_timed_out"],
		["skipped", "run_timed_out"],
		["skipped", "run_timed_out"],
	]);
});
