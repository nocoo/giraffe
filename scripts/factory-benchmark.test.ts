import { expect, it } from "vitest";
import {
	BenchmarkClock,
	benchmarkGithub,
	benchmarkLatency,
	runBenchmark,
} from "./factory-benchmark";

it("advances simultaneous requests by their maximum latency, not their sum", async () => {
	const clock = new BenchmarkClock(0);
	await Promise.all([clock.sleep(100), clock.sleep(250), clock.sleep(100)]);
	expect(clock.now).toBe(250);
	await clock.sleep(50);
	expect(clock.now).toBe(300);
});

it("pins the latency model to the brief rather than tuning the after result", () => {
	expect(benchmarkLatency("issues") * 180).toBeCloseTo(246_000);
	expect(benchmarkLatency("prs") * 360).toBeCloseTo(391_000);
	expect(benchmarkLatency("actions-stream") * 127).toBeCloseTo(428_000);
	expect(benchmarkLatency("actions-snapshot") * 13).toBeCloseTo(42_700);
});

it("waits for native work before advancing competing virtual requests", async () => {
	const clock = new BenchmarkClock(0);
	const slow = clock.sleep(250);
	const native = clock.track(new Promise<void>((done) => setTimeout(done, 10)));
	const fast = native.then(() => clock.sleep(100));
	await Promise.all([slow, fast]);
	expect(clock.now).toBe(250);
});

it("rejects non-fixture destinations and unsupported fixture requests", async () => {
	const github = benchmarkGithub(new BenchmarkClock(0), 1);
	await expect(github.fetch("https://api.github.com/repos/octocat/example")).rejects.toThrow(
		"refuses",
	);
	await expect(github.fetch("https://factory-benchmark.invalid/unsupported")).rejects.toThrow(
		"Unknown",
	);
	expect(github.unsupported).toHaveLength(2);
	expect(github.metrics()).toEqual({});
});

it("honors since while keeping canonical pagination links inside the fake handler", async () => {
	const github = benchmarkGithub(new BenchmarkClock(Date.parse("2026-10-23T00:00:00Z")), 1);
	const base = "https://factory-benchmark.invalid/repos/octocat/bench-000/issues";
	const full = await github.fetch(base);
	expect(full.headers.get("link")).toContain("https://api.github.com/");
	const recent = await github.fetch(`${base}?since=2026-10-22T00:00:00Z`);
	expect(recent.headers.get("link")).toBeNull();
	expect(await recent.json()).toHaveLength(1);
});

it("executes and publishes an isolated daily with consistent accounting", async () => {
	const result = await runBenchmark({ repos: 2, warm: false });
	expect(result.measured.status).toBe("completed");
	expect(result.measured.published).toBe(true);
	expect(result.measured.requests).toBe(result.measured.observedRequests);
	expect(result.measured.stepStatuses).toEqual({ success: result.measured.steps });
	expect(result.measured.invocations).toBeGreaterThan(1);
	expect(result.measured.simulatedWallMs).toBeGreaterThan(0);
}, 30_000);

it("replays the selected daily deterministically after a real previous-day publication", async () => {
	const first = await runBenchmark({ repos: 2, selection: "selected" });
	const second = await runBenchmark({ repos: 2, selection: "selected" });
	expect(first.measured.steps).toBe(44);
	expect(first.warmup?.published).toBe(true);
	expect(first.measured).toEqual(second.measured);
}, 30_000);
