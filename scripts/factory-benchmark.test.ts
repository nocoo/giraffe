import { expect, it, vi } from "vitest";
import {
	BenchmarkClock,
	benchmarkGithub,
	benchmarkLatency,
	benchmarkPhases,
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
	expect(clock.now).toBe(5000);
	expect(github.timing()).toEqual({
		requestWallMs: 4000,
		serialServiceMs: 4000,
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

it("measures lane occupancy from work intervals without counting delivery gaps as busy", () => {
	const phases = benchmarkPhases(
		[
			{ phase: "factory", repo: "a", start: 0, end: 4 },
			{ phase: "factory", repo: "b", start: 1, end: 4 },
			{ phase: "factory", repo: "c", start: 2, end: 4 },
			{ phase: "factory", repo: "d", start: 3, end: 4 },
			{ phase: "factory", repo: "e", start: 5, end: 6 },
			{ phase: "activity", repo: "a", start: 7, end: 10 },
		],
		0,
		10,
	);
	expect(phases[0]).toMatchObject({
		wallMs: 6,
		exclusiveWallMs: 7,
		laneMs: [1, 2, 1, 1, 1],
		averageBusyLanes: 11 / 6,
	});
	expect(phases[1]).toMatchObject({
		wallMs: 3,
		exclusiveWallMs: 3,
		laneMs: [0, 3, 0, 0, 0],
		averageBusyLanes: 1,
	});
});

it("counts a repository lane once and shares overlapping phase wall time explicitly", () => {
	const phases = benchmarkPhases(
		[
			{ phase: "factory", repo: "a", start: 0, end: 4 },
			{ phase: "factory", repo: "a", start: 1, end: 3 },
			{ phase: "snapshot", repo: "b", start: 2, end: 6 },
		],
		0,
		6,
	);
	expect(phases.map((phase) => phase.exclusiveWallMs)).toEqual([3, 3]);
	expect(phases[0]?.laneMs).toEqual([0, 4, 0, 0, 0]);
});

it("models nine notification pages instead of an empty account prelude", async () => {
	const github = benchmarkGithub(new BenchmarkClock(0), 60);
	let url: string | null = "https://factory-benchmark.invalid/notifications?per_page=100";
	let pages = 0;
	while (url) {
		const response: Response = await github.fetch(url);
		expect(await response.json()).toHaveLength(100);
		pages++;
		const next: string | undefined = /<([^>]+)>/.exec(response.headers.get("link") ?? "")?.[1];
		url = next ? next.replace("https://api.github.com", "https://factory-benchmark.invalid") : null;
	}
	expect(pages).toBe(9);
	expect(github.metrics().notifications?.serviceMs).toBe(18_000);
});

it("models bounded pinned bootstrap pages separately from date-filtered factory commits", async () => {
	const github = benchmarkGithub(new BenchmarkClock(0), 1, undefined, 201);
	for (let page = 1; page <= 3; page++) {
		const response = await github.fetch(
			`https://factory-benchmark.invalid/repos/octocat/bench-000/commits?sha=abc&per_page=100&page=${page}`,
		);
		expect(await response.json()).toHaveLength(page === 3 ? 1 : 100);
		expect(response.headers.has("link")).toBe(page < 3);
	}
	const dated = await github.fetch(
		"https://factory-benchmark.invalid/repos/octocat/bench-000/commits?since=2026-01-01&per_page=100",
	);
	expect(await dated.json()).toHaveLength(1);
	expect(github.metrics()["landed-history"]?.requests).toBe(3);
});

it("models 205 nonempty refs, tags and history pages per sixty repositories", async () => {
	const github = benchmarkGithub(new BenchmarkClock(Date.parse("2026-10-23T00:00:00Z")), 60);
	let pages = 0;
	for (let index = 0; index < 60; index++) {
		const request = async (query: string, after: string | null = null) => {
			pages++;
			const response = await github.fetch("https://factory-benchmark.invalid/graphql", {
				body: JSON.stringify({
					query,
					variables: { name: `bench-${String(index).padStart(3, "0")}`, after, tagAfter: after },
				}),
			});
			return (await response.json()) as {
				data: {
					repository: {
						refs: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string } };
						tags: { nodes: unknown[] };
						object: { history: { nodes: unknown[] } };
					};
				};
			};
		};
		const first = await request("query ActivityRefs");
		expect(first.data.repository.refs.nodes.length).toBeGreaterThan(0);
		if (first.data.repository.refs.pageInfo.hasNextPage)
			await request("query ActivityRefs", first.data.repository.refs.pageInfo.endCursor);
		expect((await request("query ActivityTags", "tags-1")).data.repository.tags.nodes).toHaveLength(
			1,
		);
		expect(
			(await request("query ActivityBranchHistory", "history-1")).data.repository.object.history
				.nodes,
		).toHaveLength(1);
	}
	expect(pages).toBe(205);
	expect(github.metrics().activity?.requests).toBe(205);
	expect(github.metrics().activity?.serviceMs).toBeCloseTo(299_000);
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

it("honors Actions lower bounds and retains an older-than-thirty-day baseline", async () => {
	const github = benchmarkGithub(new BenchmarkClock(Date.parse("2026-10-23T00:00:00Z")), 60);
	const base = "https://factory-benchmark.invalid/repos/octocat/bench-059/actions/runs";
	const response = await github.fetch(`${base}?created=>=2026-09-23T00:00:00Z`);
	const delta = (await response.json()) as {
		total_count: number;
		workflow_runs: { created_at: string; run_started_at: string }[];
	};
	expect(delta.total_count).toBe(2);
	expect(delta.workflow_runs).toHaveLength(1);
	expect(delta.workflow_runs[0]?.created_at).toBe("2026-10-22T18:00:00.000Z");
	expect(delta.workflow_runs[0]?.run_started_at).toBe(delta.workflow_runs[0]?.created_at);
	expect(response.headers.get("link")).toContain("page=2");
	const old = (await (await github.fetch(`${base}?page=3`)).json()) as {
		total_count: number;
		workflow_runs: { created_at: string }[];
	};
	expect(old.total_count).toBe(13);
	expect(Date.parse(old.workflow_runs[0]?.created_at ?? "")).toBeLessThan(
		Date.parse("2026-09-23T00:00:00Z"),
	);
});

it("supports pinned unfiltered commit history and identical-head comparisons", async () => {
	const github = benchmarkGithub(new BenchmarkClock(Date.parse("2026-10-23T00:00:00Z")), 1);
	const base = "https://factory-benchmark.invalid/repos/octocat/bench-000";
	expect(
		await (await github.fetch(`${base}/commits?sha=abc&per_page=100&page=1`)).json(),
	).toMatchObject([{ sha: "abc", parents: [] }]);
	expect(
		await (await github.fetch(`${base}/commits?sha=abc&since=2026-10-22T00:00:00Z`)).json(),
	).toEqual([]);
	expect(await (await github.fetch(`${base}/compare/abc...abc`)).json()).toMatchObject({
		status: "identical",
		total_commits: 0,
		commits: [],
	});
	expect(await (await github.fetch(`${base}/compare/old...abc`)).json()).toMatchObject({
		status: "ahead",
		total_commits: 1,
		commits: [{ sha: "abc" }],
	});
	expect(github.unsupported).toEqual([]);
});

it("executes and publishes an isolated daily with consistent accounting", async () => {
	const result = await runBenchmark({ repos: 2, warm: false });
	expect(result.measured.status).toBe("completed");
	expect(result.measured.published).toBe(true);
	expect(result.measured.landedLedger).toEqual({ identities: 2, pending: 0, reconciling: 0 });
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
	expect(result.measured.poolOccupancy?.averageBusyLanes).toBeGreaterThan(0);
	expect(result.measured.poolOccupancy?.averageBusyLanes).toBeLessThanOrEqual(4);
	expect(result.measured.poolOccupancy?.laneMs.reduce((sum, value) => sum + value, 0)).toBeCloseTo(
		result.measured.poolOccupancy?.wallMs ?? 0,
		3,
	);
	expect(result.measured.phases.map((phase) => phase.phase)).toEqual([
		"account",
		"insights",
		"factory",
		"snapshot",
		"activity",
		"publish",
	]);
	expect(result.measured.phases.reduce((sum, phase) => sum + phase.requests, 0)).toBe(
		result.measured.requests,
	);
	expect(result.measured.phases.reduce((sum, phase) => sum + phase.exclusiveWallMs, 0)).toBeCloseTo(
		result.measured.simulatedWallMs,
		0,
	);
	for (const phase of result.measured.phases) {
		expect(phase.laneMs.reduce((sum, value) => sum + value, 0)).toBeCloseTo(phase.wallMs, 0);
		expect(phase.averageBusyLanes).toBeGreaterThanOrEqual(0);
		expect(phase.averageBusyLanes).toBeLessThanOrEqual(4);
	}
}, 30_000);

it("replays the selected daily deterministically after a real previous-day publication", async () => {
	const first = await runBenchmark({ repos: 2, selection: "selected" });
	const second = await runBenchmark({ repos: 2, selection: "selected" });
	expect(first.measured.steps).toBe(44);
	expect(first.warmup?.published).toBe(true);
	expect(first.measured).toEqual(second.measured);
}, 30_000);
