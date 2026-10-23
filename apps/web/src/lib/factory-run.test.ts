import { describe, expect, it } from "vitest";
import { factoryFixture } from "../../../../tests/fixtures/factory-snapshot";
import {
	completedRunStatus,
	FACTORY_REPO_CONCURRENCY,
	factoryRunDuration,
	makeRun,
	retryDelay,
	runProgress,
	selectRunRepos,
} from "./factory-run";
import { FACTORY_STREAMS } from "./factory-types";

const snapshot = factoryFixture();
const now = snapshot.fetched_at;
const firstRepo = snapshot.repos[0];
if (!firstRepo) throw new Error("fixture");
const repos = [firstRepo, { ...firstRepo, id: "R_2", name: "nocoo/two", language: "Go" }];
it("bounds repository concurrency and defers activity until every repository snapshot finishes", () => {
	expect(FACTORY_REPO_CONCURRENCY).toBe(4);
	const run = makeRun(
		"quick",
		"a",
		"nocoo",
		"k",
		"refresh",
		repos,
		now,
		[],
		undefined,
		undefined,
		"quick",
	);
	const firstActivity = run.steps.findIndex((step) => step.kind === "activity");
	const lastSnapshot = run.steps.reduce(
		(last, step, index) => (step.kind === "snapshot" && step.repo ? index : last),
		-1,
	);
	expect(firstActivity).toBeGreaterThan(lastSnapshot);
	expect(run.steps.slice(firstActivity).map((step) => step.kind)).toEqual([
		"activity",
		"activity",
		"publish",
	]);
});

it("estimates remaining work with four repository lanes, phase barriers and serial activity", () => {
	const run = makeRun("eta", "a", "nocoo", "k", "catalog", [], now);
	const base = run.steps[0];
	if (!base) throw new Error("fixture");
	run.steps = [
		{ ...base, status: "success", durationMs: 1000 },
		...Array.from({ length: 5 }, (_, index) => ({
			...base,
			kind: "metadata" as const,
			repo: `r${index}`,
		})),
		...Array.from({ length: 5 }, (_, index) => [
			{ ...base, kind: "snapshot" as const, repo: `r${index}` },
			{ ...base, kind: "activity" as const, repo: `r${index}` },
		]).flat(),
		{ ...base, kind: "publish" },
	];
	run.nextAttemptAt = new Date(Date.parse(now) + 2000).toISOString();
	expect(runProgress(run, now).etaSeconds).toBe(12);
});

it.each(["issues", "snapshot"] as const)(
	"admits long E alongside unfinished A in the %s phase without exceeding four lanes",
	(kind) => {
		const steps = [10_000, 1_000, 1_000, 1_000, 10_000].flatMap((durationMs, index) => [
			{ kind, repo: `r${index}`, durationMs: durationMs / 2 },
			{ kind, repo: `r${index}`, durationMs: durationMs / 2 },
		]);
		expect(factoryRunDuration(steps)).toBe(11_000);
		expect(
			factoryRunDuration(
				Array.from({ length: 9 }, (_, index) => ({ kind, repo: `r${index}`, durationMs: 1000 })),
			),
		).toBe(3000);
	},
);

it("preserves repository admission order instead of sorting longer work first", () => {
	expect(
		factoryRunDuration(
			[1000, 1000, 1000, 1000, 10_000].map((durationMs, index) => ({
				kind: "issues",
				repo: `r${index}`,
				durationMs,
			})),
		),
	).toBe(11_000);
});

it("rebuilds rolling lanes from remaining work when short repositories finish", () => {
	const run = makeRun("eta", "a", "nocoo", "k", "refresh", [], now);
	const base = run.steps[0];
	if (!base) throw new Error("fixture");
	run.steps = [
		{ ...base, status: "success", durationMs: 1000 },
		...[10, 1, 1, 1, 10].flatMap((count, index) =>
			Array.from({ length: count }, () => ({
				...base,
				kind: "issues" as const,
				repo: `r${index}`,
			})),
		),
	];
	expect(runProgress(run, now).etaSeconds).toBe(11);
	for (const step of run.steps)
		if (["r1", "r2", "r3"].includes(step.repo ?? "")) step.status = "success";
	expect(runProgress(run, now).etaSeconds).toBe(10);
});

it("keeps every repository stream and commit serial within its lane and all global work serial", () => {
	const collection = ["metadata" as const, ...FACTORY_STREAMS, "commit" as const];
	const steps = Array.from({ length: 4 }, (_, index) => [
		...collection.map((kind) => ({ kind, repo: `r${index}`, durationMs: 1000 })),
		{ kind: "snapshot" as const, repo: `r${index}`, durationMs: 3000 },
		{ kind: "activity" as const, repo: `r${index}`, durationMs: 5000 },
	]).flat();
	expect(
		factoryRunDuration([
			...steps,
			{ kind: "contributions", repo: null, durationMs: 2000 },
			{ kind: "activity-contributions", durationMs: 4000 },
			{ kind: "snapshot", repo: null, durationMs: 6000 },
			{ kind: "publish", repo: null, durationMs: 7000 },
		]),
	).toBe(collection.length * 1000 + 3000 + 4 * 5000 + 2000 + 4000 + 6000 + 7000);
	expect(factoryRunDuration([])).toBe(0);
});
it("counts limited steps as terminal independently of failures and unavailable steps", () => {
	const run = makeRun("r", "a", "nocoo", "k", "catalog", [], now);
	Object.assign(run.steps[0] ?? {}, { status: "limited", error: "coverage_limited" });
	expect(runProgress(run, now)).toMatchObject({
		completed: 1,
		limited: 1,
		failed: 0,
		unavailable: 0,
	});
	expect(completedRunStatus(run)).toBe("completed");
	Object.assign(run.steps[1] ?? {}, { status: "failed", error: "github_error" });
	expect(completedRunStatus(run)).toBe("partial");
});
it("counts unavailable steps as terminal without counting failures", () => {
	const run = makeRun("r", "a", "nocoo", "k", "catalog", [], now);
	Object.assign(run.steps[0] ?? {}, { status: "unavailable", error: "permission_denied" });
	expect(runProgress(run, now)).toMatchObject({ completed: 1, unavailable: 1, failed: 0 });
});
it("updates global pages and explicitly derives Insights before repository collection", () => {
	const run = makeRun("all", "a", "nocoo", "key", "refresh", repos, now);
	expect(run.steps.slice(0, 6).map((step) => step.resource)).toEqual([
		"repos",
		"issues",
		"prs",
		"alerts",
		"notifications",
		"insights",
	]);
	expect(run.steps[6]?.kind).toBe("contributions");
	expect(run.steps[7]).toMatchObject({ kind: "metadata", repo: "nocoo/app" });
});
it("publishes collected repositories without scheduling cloud analysis", () => {
	const run = makeRun(
		"ai",
		"a",
		"nocoo",
		"key",
		"refresh",
		[firstRepo],
		now,
		[],
		["nocoo/app", "org/other"],
	);
	expect(run.steps.map((step) => step.kind)).not.toContain("assessment");
	expect(run.steps.at(-2)?.kind).toBe("snapshot");
	expect(run.steps.at(-1)?.kind).toBe("publish");
});
describe("frozen refresh plans", () => {
	it("freezes thirty dates for quick and ninety for deep without changing the step plan", () => {
		const quick = makeRun(
			"quick",
			snapshot.account_id,
			"nocoo",
			"quick",
			"refresh",
			repos,
			now,
			[],
			[],
			{ scope: "selected" },
			"quick",
		);
		const deep = makeRun(
			"deep",
			snapshot.account_id,
			"nocoo",
			"deep",
			"refresh",
			repos,
			now,
			[],
			[],
			{ scope: "selected" },
			"deep",
		);
		expect(Date.parse(quick.window.since) - Date.parse(deep.window.since)).toBe(60 * 86400_000);
		expect(quick.window.until).toBe(deep.window.until);
		expect(quick.steps.length).toBe(deep.steps.length);
	});
	it("freezes selected order, scope, window and logical total independently of page counts", () => {
		const selection = selectRunRepos(
			repos,
			[],
			{ scope: "selected", repos: ["nocoo/two", "nocoo/app"] },
			now,
		);
		const run = makeRun("run", snapshot.account_id, "nocoo", "request", "refresh", selection, now);
		selection.reverse();
		expect(run.repos).toEqual(["nocoo/two", "nocoo/app"]);
		expect(run.steps).toHaveLength(44);
		expect(run.steps.find((step) => step.kind === "metadata")).toMatchObject({ repo: "nocoo/two" });
		run.requests = 900;
		expect(runProgress(run, now)).toMatchObject({ total: 44, completed: 0, etaSeconds: null });
		Object.assign(run.steps[0] ?? {}, { status: "success", durationMs: 1000 });
		Object.assign(run.steps[1] ?? {}, { status: "failed" });
		Object.assign(run.steps[2] ?? {}, { status: "skipped" });
		expect(runProgress(run, now)).toMatchObject({
			total: 44,
			completed: 3,
			success: 1,
			failed: 1,
			skipped: 1,
		});
	});
	it("validates selection and freezes filtered, stale and failed scopes", () => {
		expect(() =>
			selectRunRepos(repos, [], { scope: "selected", repos: ["evil/no"] }, now),
		).toThrow();
		expect(() =>
			selectRunRepos(repos, [], { scope: "selected", repos: ["nocoo/app", "nocoo/app"] }, now),
		).toThrow();
		expect(
			selectRunRepos(repos, [], { scope: "filter", language: "Go" }, now).map((r) => r.name),
		).toEqual(["nocoo/two"]);
		expect(
			selectRunRepos(repos, [], { scope: "filter", topic: "cli", query: "Example" }, now),
		).toHaveLength(2);
		const states = [
			{ repo: "nocoo/app", refreshedAt: now, status: "success" as const, nextAllowedAt: now },
		];
		expect(selectRunRepos(repos, states, { scope: "stale" }, now).map((r) => r.name)).toEqual([
			"nocoo/two",
		]);
		expect(selectRunRepos(repos, states, { scope: "failed" }, now)).toEqual([]);
		expect(
			selectRunRepos(
				repos,
				[{ ...{ repo: "nocoo/app", refreshedAt: now, nextAllowedAt: now }, status: "failed" }],
				{ scope: "failed" },
				now,
			),
		).toHaveLength(1);
	});
	it("skips cooling repositories up front and plans discovery without pretending to know page count", () => {
		const r = makeRun("run", "a", "nocoo", "key", "refresh", repos, now, [
			{
				repo: "nocoo/app",
				refreshedAt: now,
				status: "success",
				nextAllowedAt: "2999-01-01T00:00:00.000Z",
			},
		]);
		expect(runProgress(r, now).skipped).toBe(9);
		expect(makeRun("r", "a", "nocoo", "k", "catalog", [], now).steps.map((s) => s.kind)).toEqual([
			"inventory",
			"snapshot",
			"restore",
			"publish",
		]);
		expect(retryDelay(1)).toBe(30);
		expect(retryDelay(8)).toBe(900);
	});
});

it("handles empty scopes, real duration estimates and stale observations", () => {
	expect(selectRunRepos(repos, [], { scope: "selected" }, now)).toEqual([]);
	expect(selectRunRepos(repos, [], { scope: "all" }, now)).toHaveLength(2);
	expect(selectRunRepos(repos, [], { scope: "filter", topic: "missing" }, now)).toEqual([]);
	expect(selectRunRepos(repos, [], { scope: "filter", query: "missing" }, now)).toEqual([]);
	expect(
		selectRunRepos(
			repos.map((r) => ({ ...r, description: null })),
			[],
			{ scope: "filter", query: "nocoo" },
			now,
		),
	).toHaveLength(2);
	expect(
		selectRunRepos(
			repos,
			[{ repo: "nocoo/app", status: "success", refreshedAt: "2000-01-01", nextAllowedAt: now }],
			{ scope: "stale" },
			now,
		),
	).toHaveLength(2);
	const run = makeRun("a", "a", "a", "a", "catalog", [], now);
	Object.assign(run.steps[0] ?? {}, { status: "success", durationMs: 1000 });
	expect(runProgress(run, now).etaSeconds).toBe(3);
	run.status = "paused";
	run.cursor = 4;
	expect(runProgress(run, now)).toMatchObject({ etaSeconds: null, current: null });
	expect(retryDelay(0)).toBe(30);
});

it("resolves an explicit repository predicate as part of a server-side filter", () => {
	expect(
		selectRunRepos(repos, [], { scope: "filter", repo: "nocoo/two" }, now).map((r) => r.name),
	).toEqual(["nocoo/two"]);
});

it("includes every site page and freezes detail targets outside the factory metrics catalog", () => {
	const names = ["nocoo/app", "team/archived-fork"];
	const run = makeRun("run", "a", "nocoo", "key", "refresh", [firstRepo], now, [], names);
	names.reverse();
	expect(run.siteRepos).toEqual(["nocoo/app", "team/archived-fork"]);
	expect(run.repos).toEqual(["nocoo/app"]);
	const resources = run.steps.filter((s) => s.kind === "snapshot").map((s) => s.resource);
	expect(resources).toEqual(
		expect.arrayContaining(["repos", "issues", "prs", "alerts", "notifications"]),
	);
	for (const repo of names) {
		for (const tab of [
			"details",
			"actions",
			"traffic",
			"security",
			"issues",
			"prs",
			"releases",
			"languages",
			"contributors",
		])
			expect(resources).toContain(`repo:${repo}:${tab}`);
	}
});

it.each(["selected", "filter", "stale", "failed"] as const)(
	"bounds %s refresh work to the resolved repositories regardless of site size",
	(scope) => {
		const names = ["nocoo/app", ...Array.from({ length: 160 }, (_, i) => `org/repo${i}`)];
		const run = makeRun("run", "a", "nocoo", "key", "refresh", [firstRepo], now, [], names, {
			scope,
		});
		expect(run.siteRepos).toEqual(["nocoo/app"]);
		expect(run.steps).toHaveLength(19);
		expect(run.steps.filter((step) => step.kind === "snapshot")).toHaveLength(9);
		expect(run.steps.filter((step) => step.repo === null).map((step) => step.kind)).toEqual([
			"publish",
		]);
		expect(run.steps.every((step) => step.repo === null || step.repo === "nocoo/app")).toBe(true);
	},
);
