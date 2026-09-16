import { describe, expect, it } from "vitest";
import { factoryFixture } from "../../tests/fixtures/factory-snapshot";
import { makeRun, retryDelay, runProgress, selectRunRepos } from "./factory-run";

const snapshot = factoryFixture();
const now = snapshot.fetched_at;
const firstRepo = snapshot.repos[0];
if (!firstRepo) throw new Error("fixture");
const repos = [firstRepo, { ...firstRepo, id: "R_2", name: "nocoo/two", language: "Go" }];
describe("frozen refresh plans", () => {
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
		expect(run.steps).toHaveLength(20);
		expect(run.steps[1]).toMatchObject({ kind: "metadata", repo: "nocoo/two" });
		run.requests = 900;
		expect(runProgress(run, now)).toMatchObject({ total: 20, completed: 0, etaSeconds: null });
		Object.assign(run.steps[0] ?? {}, { status: "success", durationMs: 1000 });
		Object.assign(run.steps[1] ?? {}, { status: "failed" });
		Object.assign(run.steps[2] ?? {}, { status: "skipped" });
		expect(runProgress(run, now)).toMatchObject({
			total: 20,
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
	expect(runProgress(run, now).etaSeconds).toBe(2);
	run.status = "paused";
	run.cursor = 3;
	expect(runProgress(run, now)).toMatchObject({ etaSeconds: null, current: null });
	expect(retryDelay(0)).toBe(30);
});

it("resolves an explicit repository predicate as part of a server-side filter", () => {
	expect(
		selectRunRepos(repos, [], { scope: "filter", repo: "nocoo/two" }, now).map((r) => r.name),
	).toEqual(["nocoo/two"]);
});
