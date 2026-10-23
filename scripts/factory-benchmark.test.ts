import { expect, it, vi } from "vitest";
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

it("suspends clock scheduling instead of polling while native work is pending", async () => {
	vi.useFakeTimers();
	try {
		const clock = new BenchmarkClock(0);
		let finish = () => {};
		const native = clock.track(
			new Promise<void>((done) => {
				finish = done;
			}),
		);
		const request = clock.sleep(100);
		const timersDuringNativeWork = vi.getTimerCount();
		finish();
		await native;
		await vi.runAllTimersAsync();
		await request;
		expect(timersDuringNativeWork).toBe(0);
		expect(clock.now).toBe(100);
	} finally {
		vi.useRealTimers();
	}
});

it("deterministically overlaps unequal request chains without conflating wall and service time", async () => {
	const results = [];
	for (let iteration = 0; iteration < 3; iteration++) {
		const start = Date.parse("2026-10-23T00:00:00Z");
		const clock = new BenchmarkClock(start);
		const github = benchmarkGithub(clock, 2);
		const root = "https://factory-benchmark.invalid/repos/octocat";
		const chains = [
			async () => {
				await github.fetch(`${root}/bench-000/issues`);
				await clock.track(new Promise<void>((done) => setTimeout(done, iteration + 1)));
				await github.fetch(`${root}/bench-000/pulls`);
			},
			async () => {
				await github.fetch(`${root}/bench-001/actions/runs`);
				await github.fetch(`${root}/bench-001/languages`);
			},
		];
		await Promise.all(chains.map((chain) => chain()));
		const longest = benchmarkLatency("actions-snapshot") + benchmarkLatency("snapshot");
		const totalService = longest + benchmarkLatency("issues") + benchmarkLatency("prs");
		expect(clock.now - start).toBeCloseTo(longest, 3);
		expect(github.timing()).toEqual({
			requestWallMs: expect.closeTo(longest, 3),
			serialServiceMs: expect.closeTo(totalService, 3),
			maxConcurrentRequests: 2,
		});
		results.push(github.timing());
	}
	expect(results[0]).toEqual(results[1]);
	expect(results[1]).toEqual(results[2]);
});

it("excludes gaps between requests from request wall time and resets timing between runs", async () => {
	const clock = new BenchmarkClock(0);
	const github = benchmarkGithub(clock, 1);
	await github.fetch("https://factory-benchmark.invalid/notifications");
	await clock.sleep(1000);
	await github.fetch("https://factory-benchmark.invalid/notifications");
	expect(clock.now).toBe(1600);
	expect(github.timing()).toEqual({
		requestWallMs: 600,
		serialServiceMs: 600,
		maxConcurrentRequests: 1,
	});
	github.reset();
	expect(github.metrics()).toEqual({});
	expect(github.timing()).toEqual({
		requestWallMs: 0,
		serialServiceMs: 0,
		maxConcurrentRequests: 0,
	});
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
	expect(result.measured.requestWallMs).toBeGreaterThan(0);
	expect(result.measured.requestWallMs).toBeLessThanOrEqual(result.measured.serialServiceMs);
	expect(result.measured.simulatedWallMs).toBe(
		result.measured.requestWallMs + result.measured.waitingMs,
	);
	expect(result.measured.maxConcurrentRequests).toBeGreaterThanOrEqual(1);
}, 30_000);

it("replays the selected daily deterministically after a real previous-day publication", async () => {
	const first = await runBenchmark({ repos: 2, selection: "selected" });
	const second = await runBenchmark({ repos: 2, selection: "selected" });
	expect(first.measured.steps).toBe(44);
	expect(first.warmup?.published).toBe(true);
	expect(first.measured).toEqual(second.measured);
}, 30_000);
