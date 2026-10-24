// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { emptyDay } from "../../lib/factory";
import { FACTORY_STREAMS, type FactoryStreamName } from "../../lib/factory-types";
import {
	activityQuadrant,
	backlogRows,
	factoryBoard,
	factoryFreshness,
	formatFactoryCount,
} from "./factory";

it("does not turn recovered or disconnected historical stream coverage into complete zeroes", () => {
	const { snapshot, repo, board } = fixture();
	Object.assign(repo.coverage.commits, {
		completeWindows: [
			{ since: snapshot.window.since, until: "2026-08-01T00:00:00.000Z" },
			{ since: "2026-10-01T00:00:00.000Z", until: now },
		],
	});
	const result = board();
	expect(result.days.find((day) => day.date === "2026-07-25")?.complete.commits).toBe(true);
	expect(result.days.find((day) => day.date === "2026-08-15")?.complete.commits).toBe(false);
	expect(result.days.find((day) => day.date === "2026-10-22")?.complete.commits).toBe(true);
	expect(result.periods.at(-1)?.previousComplete.commits).toBe(false);
});

const now = "2026-10-23T05:00:00.000Z";
const old = "2026-10-18T05:00:00.000Z";
const oldWindow = { since: "2026-07-20T00:00:00.000Z", until: old };

function fixture(streams: FactoryStreamName[] = []) {
	const snapshot = factoryFixture();
	const repo = snapshot.repos[0];
	if (!repo) throw new Error("Missing repository fixture");
	snapshot.window = { since: "2026-07-25T00:00:00.000Z", until: now };
	repo.observation = {
		version: "current",
		source: "run",
		window: snapshot.window,
		refreshedAt: now,
	};
	for (const stream of FACTORY_STREAMS)
		repo.coverage[stream] = {
			...repo.coverage[stream],
			status: "complete",
			fetchedAt: now,
			...(streams.includes(stream)
				? {
						retained: true,
						fetchedAt: old,
						observation: {
							...repo.observation,
							version: "previous",
							window: { ...oldWindow },
							refreshedAt: old,
							head: "old-head",
						},
					}
				: {}),
		};
	return { snapshot, repo, board: () => factoryBoard(snapshot, [repo], [repo]) };
}

it("keeps healthy timelines current while testing each retained day and period against its own window", () => {
	const { repo, board } = fixture(["commits"]);
	repo.metrics.days = {
		"2026-07-22": { ...emptyDay(), commits: 1 },
		"2026-10-17": { ...emptyDay(), commits: 2 },
		"2026-10-22": { ...emptyDay(), releases: 1 },
	};
	const before = structuredClone(repo);
	const result = board();
	expect(result.mixedWindows).toBe(true);
	expect(result.displayWindow).toEqual({ ...oldWindow, until: now });
	expect(result.days.find((day) => day.date === "2026-07-22")).toMatchObject({
		commits: 1,
		complete: { commits: true, releases: false },
	});
	expect(result.days.find((day) => day.date === "2026-10-17")?.complete.commits).toBe(true);
	expect(result.days.find((day) => day.date === "2026-10-18")?.complete.commits).toBe(false);
	expect(result.days.find((day) => day.date === "2026-10-22")).toMatchObject({
		commits: 0,
		releases: 1,
		complete: { commits: false, releases: true },
	});
	expect(result.periods[0]).toMatchObject({
		since: "2026-10-22",
		until: "2026-10-22",
		current: { releases: 1 },
		complete: { commits: false, releases: true },
		previousComplete: { commits: false, releases: true },
	});
	expect(result.periods[1]).toMatchObject({
		complete: { commits: false, releases: true },
		previousComplete: { commits: true, releases: true },
	});
	expect(repo).toEqual(before);
});

it("requires all seven stream days for rolling breadth and CI, without hiding covered history", () => {
	const { repo, board } = fixture(["commits", "actions"]);
	repo.metrics.days = { "2026-10-17": { ...emptyDay(), commits: 1, ciSuccess: 2 } };
	const result = board();
	expect(result.days.find((day) => day.date === "2026-10-17")).toMatchObject({
		activeRepos7: 1,
		ciRate7: 1,
	});
	for (const date of ["2026-10-18", "2026-10-22"])
		expect(result.days.find((day) => day.date === date)).toMatchObject({
			activeRepos7: null,
			ciRate7: null,
		});
	expect(result.repoActivity[0]?.known.commits).toBe(false);
	expect(result.activity).toEqual({ week: 0, month: 0, dormant: 0, unknown: 1 });
	expect(activityQuadrant(result.repoActivity).points).toEqual([]);
});

it("does not back-project current stock through retained event gaps or report aged backlog as current", () => {
	const { repo, board } = fixture(["issues"]);
	repo.metrics.agedIssues = 4;
	repo.metrics.agedPrs = 2;
	const result = board();
	expect(result.days.every((day) => day.openIssues === null)).toBe(true);
	expect(result.days.at(-1)?.openPrs).toBe(repo.openPrs);
	expect(result.repoActivity[0]).toMatchObject({
		openIssues: repo.openIssues,
		agedIssues: null,
		agedPrs: 2,
		known: { issues: false, prs: true, commits: true },
	});
	expect(result.periods[0]?.stock.openIssues).toEqual({ from: null, to: null });
	const backlog = backlogRows(result.repoActivity);
	expect(backlog.rows[0]?.done30).toBeNull();
	expect(backlog.aged).toBeNull();
	expect(formatFactoryCount(backlog.rows[0]?.done30 ?? null)).toBe("—");
});

it("stops stock reconstruction at the first uncovered day and bounds rolling coverage at the start", () => {
	const { repo, board } = fixture(["dependencies"]);
	if (!repo.observation) throw new Error("Missing observation");
	repo.observation.window = { since: "2026-10-20T00:00:00.000Z", until: now };
	const result = board();
	expect(result.days.find((day) => day.date === "2026-10-20")?.openIssues).toBe(repo.openIssues);
	expect(result.days.find((day) => day.date === "2026-10-19")?.openIssues).toBeNull();
	expect(result.days.at(-1)?.activeRepos7).toBeNull();
	expect(result.activity).toEqual({ week: 0, month: 0, dormant: 0, unknown: 1 });
});

it("does not freeze healthy metrics or mark quiet current repositories unknown for retained dependencies", () => {
	const { repo, board } = fixture(["dependencies"]);
	repo.metrics.days = { "2026-10-22": { ...emptyDay(), ciSuccess: 1 } };
	const result = board();
	expect(result.periods[0]).toMatchObject({
		until: "2026-10-22",
		complete: { commits: true, actions: true, issues: true, prs: true, releases: true },
	});
	expect(result.days.at(-1)).toMatchObject({ activeRepos7: 0, ciRate7: 1 });
	expect(result.activity).toEqual({ week: 0, month: 0, dormant: 1, unknown: 0 });
});

it("includes retained and healthy stream times without multiplying the selected repository denominator", () => {
	const { snapshot, repo } = fixture(["commits"]);
	const fetched = "2026-10-23T04:00:00.000Z";
	for (const stream of FACTORY_STREAMS)
		if (stream !== "commits") repo.coverage[stream].fetchedAt = fetched;
	const selected = [repo, { ...repo, name: "nocoo/missing" }];
	expect(factoryBoard(snapshot, [repo], selected).freshness).toEqual({
		oldestAt: old,
		latestAt: fetched,
		total: 2,
		missing: 1,
	});
	expect(factoryFreshness([repo])).toEqual({
		oldestAt: old,
		latestAt: fetched,
		total: 1,
		missing: 0,
	});
});

it("keeps the current publication timeline visible even when every stream is retained", () => {
	const { board } = fixture([...FACTORY_STREAMS]);
	const result = board();
	expect(result.displayWindow.until).toBe(now);
	expect(result.mixedWindows).toBe(true);
	expect(result.days.at(-1)?.date).toBe("2026-10-23");
	expect(Object.values(result.days.at(-1)?.complete ?? {}).every((complete) => !complete)).toBe(
		true,
	);
});

it("keeps covered complete-day periods while withholding stale point-in-time aged backlog", () => {
	const { repo, board } = fixture(["issues", "prs"]);
	for (const stream of ["issues", "prs"] as const) {
		const observation = repo.coverage[stream].observation;
		if (!observation) throw new Error("Missing retained observation");
		observation.window.until = "2026-10-23T00:00:00.000Z";
	}
	repo.metrics.agedIssues = 3;
	repo.metrics.agedPrs = 2;
	const result = board();
	expect(result.periods[0]?.complete).toMatchObject({ issues: true, prs: true });
	expect(result.repoActivity[0]).toMatchObject({ agedIssues: null, agedPrs: null });
});
