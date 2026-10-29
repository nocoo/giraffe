// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
	factoryFixture as ready,
	savedFactoryWindow,
} from "../../../../../tests/fixtures/factory-snapshot";
import { emptyDay } from "../../lib/factory";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import {
	activityAge,
	activityQuadrant,
	backlogRows,
	dependencyEdges,
	eventPage,
	factoryBoard,
	factoryDays,
	factoryGroups,
	factoryParams,
	factoryRange,
	factoryRepoCommits,
	factoryRepoCount,
	factoryRepoPage,
	factorySignalGroups,
	factorySignalPage,
	filterFactoryRepos,
	hasFactoryMeasurement,
	periodChange,
	STREAM_CODES,
	safeGithubUrl,
} from "./factory";

describe("software factory view model", () => {
	it("keeps repository spark gaps, complete zeros and partial lower bounds distinct", () => {
		const snapshot = ready();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		repo.coverage.commits.status = "partial";
		repo.coverage.commits.completeWindows = shanghaiCompleteDays(["2026-09-13"]);
		repo.metrics.days = {
			"2026-09-13": emptyDay(),
			"2026-09-14": emptyDay(),
			"2026-09-15": { ...emptyDay(), commits: 2 },
		};
		expect(
			factoryRepoCommits(
				repo,
				["2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15"],
				snapshot.window,
			),
		).toEqual([null, 0, null, 2]);
		repo.coverage.commits.status = "complete";
		expect(factoryRepoCommits(repo, ["2026-09-12"], snapshot.window)).toEqual([null]);
		delete repo.coverage.commits.completeWindows;
		expect(factoryRepoCommits(repo, ["2026-09-13"], snapshot.window)).toEqual([0]);
		repo.observation = {
			version: "saved",
			source: "run",
			refreshedAt: snapshot.fetched_at,
			window: shanghaiCompleteDays(["2026-09-13"])[0] ?? snapshot.window,
		};
		expect(factoryRepoCommits(repo, ["2026-09-13"], snapshot.window)).toEqual([0]);
		repo.observation.collectionWindow = repo.observation.window;
		expect(factoryRepoCommits(repo, ["2026-09-13"], snapshot.window)).toEqual([0]);
		repo.coverage.commits.observation = { ...repo.observation, head: null };
		expect(factoryRepoCommits(repo, ["2026-09-13"], snapshot.window)).toEqual([0]);
	});
	it.each([
		["Asia/Shanghai", "2026-10-28", "2026-10-27T16:00:00Z", "2026-10-28T15:59:59.999Z"],
		["America/New_York", "2026-03-08", "2026-03-08T05:00:00Z", "2026-03-09T03:59:59.999Z"],
		["America/New_York", "2026-11-01", "2026-11-01T04:00:00Z", "2026-11-02T04:59:59.999Z"],
	])(
		"preserves a complete calendar day and its one-day flow in %s",
		(timezone, date, since, until) => {
			const snapshot = ready();
			const repo = snapshot.repos[0];
			if (!repo) throw new Error("fixture");
			snapshot.window = { since, until, timezone };
			repo.metrics.days = { [date]: { ...emptyDay(), commits: 2 } };
			for (const stream of FACTORY_STREAMS) repo.coverage[stream].status = "complete";
			const board = factoryBoard(snapshot, snapshot.repos, snapshot.repos);
			expect(board.days).toHaveLength(90);
			expect(board.days.at(-1)).toMatchObject({ date, commits: 2, complete: { commits: true } });
			expect(board.periods[0]).toMatchObject({
				since: date,
				until: date,
				current: { commits: 2 },
				complete: { commits: true },
			});
			expect(board.repoActivity[0]?.periods[1].commits).toBe(2);
		},
	);
	it("withholds incompatible per-source calendar aggregation across timezones", () => {
		const snapshot = ready();
		const first = snapshot.repos[0];
		if (!first) throw new Error("fixture");
		snapshot.window = {
			since: "2026-10-27T16:00:00Z",
			until: "2026-10-28T15:59:59.999Z",
			timezone: "Asia/Shanghai",
		};
		first.metrics.days = { "2026-10-28": { ...emptyDay(), commits: 2 } };
		for (const stream of FACTORY_STREAMS) first.coverage[stream].status = "complete";
		first.coverage.commits.observation = {
			version: "dst-source",
			source: "run",
			refreshedAt: snapshot.fetched_at,
			head: null,
			window: {
				since: "2026-03-08T05:00:00Z",
				until: "2026-03-09T03:59:59.999Z",
				timezone: "America/New_York",
			},
		};
		const board = factoryBoard(snapshot, snapshot.repos, snapshot.repos);
		expect(board.mixedTimezones).toBe(true);
		expect(board.days).toEqual([]);
		expect(board.periods[0]?.complete.commits).toBe(false);
		expect(board.repoActivity).toEqual([]);
	});
	it.each([30, 90])(
		"keeps the default 90-day span over a %i-day published UTC window",
		(dayCount) => {
			const snapshot = ready();
			snapshot.window = savedFactoryWindow(snapshot.fetched_at, dayCount);
			const board = factoryBoard(snapshot, snapshot.repos, snapshot.repos);
			expect(board.days).toHaveLength(90);
			expect(board.days.at(-dayCount)?.date).toBe(snapshot.window.since.slice(0, 10));
			expect(board.days.at(-1)?.date).toBe(snapshot.window.until.slice(0, 10));
			expect(board.days.every((day) => !day.observed && day.commits === null)).toBe(true);
			expect(board.displayWindow).toEqual({
				since: `${board.days[0]?.date}T00:00:00.000Z`,
				until: "2026-09-16T00:00:00.000Z",
				timezone: "UTC",
			});
		},
	);
	it("ends the default 90-day view at the latest observed day, not the requested window end", () => {
		const snapshot = ready();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		snapshot.window = savedFactoryWindow(snapshot.fetched_at, 90);
		for (const stream of FACTORY_STREAMS) repo.coverage[stream].status = "complete";
		repo.metrics.days = {
			"2026-07-01": { ...emptyDay(), commits: 3 },
			"2026-09-10": { ...emptyDay(), commits: 4 },
		};
		const board = factoryBoard(snapshot, snapshot.repos, snapshot.repos);
		expect(board.days[0]?.date).toBe("2026-06-13");
		expect(board.days[0]).toMatchObject({ observed: false, commits: null });
		expect(board.days.at(-1)?.date).toBe("2026-09-10");
		expect(board.days.at(-1)).toMatchObject({ observed: true, commits: 4 });
		expect(board.days).toHaveLength(90);
		expect(board.availableDays).toBe(85);
		expect(board.periods[0]).toMatchObject({ since: "2026-09-10", until: "2026-09-10" });
		expect(board.days.at(-1)?.openPrs).toBeNull();
		expect(board.periods[0]?.stock.openPrs).toEqual({ from: null, to: null });
		expect(board.displayWindow).toEqual({
			since: "2026-06-13T00:00:00.000Z",
			until: "2026-09-11T00:00:00.000Z",
			timezone: "UTC",
		});
	});
	it.each([
		[30, 30],
		[90, 90],
		[180, 180],
		[365, 365],
	])("keeps the selected %i-day span ending at the latest observed day", (range, days) => {
		const snapshot = ready();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		snapshot.window = savedFactoryWindow(snapshot.fetched_at, 90);
		repo.metrics.days = {
			"2026-07-01": { ...emptyDay(), commits: 3 },
			"2026-09-10": { ...emptyDay(), commits: 4 },
		};
		const board = factoryBoard(snapshot, [repo], [repo], range);
		expect(board.days).toHaveLength(days);
		expect(board.days.at(-1)).toMatchObject({ date: "2026-09-10", observed: true, commits: 4 });
		expect(board.availableDays).toBe(85);
		expect(board.days[0]).toMatchObject({
			observed: false,
			commits: null,
			complete: { commits: false },
		});
	});
	it("keeps the selected span before the published window as missing days", () => {
		const snapshot = ready();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		snapshot.window = {
			since: "2026-09-08T00:00:00Z",
			until: "2026-09-11T00:00:00Z",
			timezone: "UTC",
		};
		repo.metrics.days = { "2026-09-10": { ...emptyDay(), commits: 2 } };
		const board = factoryBoard(snapshot, [repo], [repo], 30);
		expect(board.days).toHaveLength(30);
		expect(board.availableDays).toBe(3);
		expect(board.days.at(-1)).toMatchObject({ date: "2026-09-10", observed: true, commits: 2 });
		expect(board.days[0]).toMatchObject({
			date: "2026-08-12",
			observed: false,
			commits: null,
			complete: { commits: false },
		});
		expect(board.days.slice(0, -1).every((day) => !day.observed)).toBe(true);
		expect(board.displayWindow).toEqual({
			since: "2026-08-12T00:00:00.000Z",
			until: "2026-09-11T00:00:00.000Z",
			timezone: "UTC",
		});
	});
	it("treats an observed zero-activity day as the latest observation", () => {
		const snapshot = ready();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		snapshot.window = {
			since: "2026-09-08T00:00:00Z",
			until: "2026-09-12T00:00:00Z",
			timezone: "UTC",
		};
		repo.metrics.days = {
			"2026-09-08": { ...emptyDay(), commits: 3 },
			"2026-09-11": emptyDay(),
		};
		const board = factoryBoard(snapshot, [repo], [repo]);
		expect(board.days).toHaveLength(90);
		expect(board.days.at(-1)).toMatchObject({ date: "2026-09-11", observed: true, commits: 0 });
	});
	it("parses chart range options with the historical 90-day default", () => {
		expect(factoryRange(null)).toBe(90);
		expect(factoryRange("30")).toBe(30);
		expect(factoryRange("365")).toBe(365);
		expect(factoryRange("45")).toBe(90);
		expect(factoryRange(undefined)).toBe(90);
	});
	it("keeps repo-days without observations empty instead of plotting a fabricated zero", () => {
		const snapshot = ready();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		snapshot.window = {
			since: "2026-09-07T16:00:00Z",
			until: "2026-09-10T15:59:59.999Z",
			timezone: "Asia/Shanghai",
		};
		repo.coverage.commits.status = "complete";
		repo.coverage.commits.completeWindows = [
			{
				since: "2026-09-07T16:00:00Z",
				until: "2026-09-10T15:59:59.999Z",
				timezone: "Asia/Shanghai",
			},
		];
		repo.metrics.days = { "2026-09-09": { ...emptyDay(), commits: 2 } };
		const board = factoryBoard(snapshot, [repo], [repo]);
		expect(board.days).toHaveLength(90);
		expect(board.days.slice(-2).map((d) => d.date)).toEqual(["2026-09-08", "2026-09-09"]);
		expect(board.days.at(-2)).toMatchObject({
			observed: false,
			commits: null,
			issueOpened: null,
			releases: null,
			complete: { commits: true },
		});
		expect(board.days.at(-1)).toMatchObject({ observed: true, commits: 2 });
		const unobserved = board.days.slice(0, -2);
		expect(unobserved.every((day) => !day.observed && day.commits === null)).toBe(true);
	});
	it("renders a partial unified-refresh window with the failed day empty, not zero", () => {
		const snapshot = ready();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		snapshot.window = {
			since: "2026-10-26T16:00:00Z",
			until: "2026-10-29T15:59:59.999Z",
			timezone: "Asia/Shanghai",
		};
		repo.observation = {
			version: "run",
			source: "run",
			refreshedAt: snapshot.fetched_at,
			window: snapshot.window,
		};
		repo.coverage.commits.status = "partial";
		repo.coverage.commits.completeWindows = [
			{
				since: "2026-10-26T16:00:00Z",
				until: "2026-10-27T15:59:59.999Z",
				timezone: "Asia/Shanghai",
			},
			{
				since: "2026-10-28T16:00:00Z",
				until: "2026-10-29T15:59:59.999Z",
				timezone: "Asia/Shanghai",
			},
		];
		repo.metrics.days = {
			"2026-10-27": { ...emptyDay(), commits: 5 },
			"2026-10-29": { ...emptyDay(), commits: 1 },
		};
		const board = factoryBoard(snapshot, [repo], [repo]);
		expect(board.days).toHaveLength(90);
		expect(board.days.slice(-3).map((day) => day.date)).toEqual([
			"2026-10-27",
			"2026-10-28",
			"2026-10-29",
		]);
		expect(board.days.at(-2)).toMatchObject({
			observed: false,
			commits: null,
			complete: { commits: false },
		});
		expect(board.days.at(-1)).toMatchObject({ observed: true, commits: 1 });
		expect(board.days[0]?.timezone).toBe("Asia/Shanghai");
	});
	it("unions adjacent one-day complete windows into whole periods", () => {
		const snapshot = ready();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		snapshot.window = {
			since: "2026-09-08T00:00:00.000Z",
			until: "2026-09-14T23:59:59.999Z",
			timezone: "UTC",
		};
		repo.metrics.days = { "2026-09-14": emptyDay() };
		repo.coverage.commits.status = "partial";
		repo.coverage.commits.completeWindows = utcCompleteDays(utcDates("2026-09-08", 7));
		const board = factoryBoard(snapshot, [repo], [repo], 30);
		expect(board.days.slice(-7).map((day) => day.date)).toEqual(utcDates("2026-09-08", 7));
		expect(board.days.slice(-7).every((day) => day.complete.commits)).toBe(true);
		expect(board.days.slice(0, -7).every((day) => !day.complete.commits && !day.observed)).toBe(
			true,
		);
		expect(board.periods[1]).toMatchObject({
			since: "2026-09-08",
			until: "2026-09-14",
			complete: { commits: true },
		});
		expect(board.periods[2]?.complete.commits).toBe(false);
	});
	it("covers the whole published span when every day is complete", () => {
		const snapshot = ready();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		const dates = utcDates("2026-06-18", 90);
		snapshot.window = {
			since: "2026-06-18T00:00:00.000Z",
			until: "2026-09-15T23:59:59.999Z",
			timezone: "UTC",
		};
		repo.metrics.days = { "2026-09-15": emptyDay() };
		repo.coverage.commits.status = "partial";
		repo.coverage.commits.completeWindows = utcCompleteDays(dates);
		const board = factoryBoard(snapshot, [repo], [repo]);
		expect(board.days.map((day) => day.date)).toEqual(dates);
		expect(board.days.every((day) => day.complete.commits)).toBe(true);
		expect(board.periods[1]?.complete.commits).toBe(true);
		expect(board.periods[2]?.complete.commits).toBe(true);
	});
	it("keeps a missing day as a gap instead of certifying the period", () => {
		const snapshot = ready();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		const dates = utcDates("2026-09-08", 7);
		snapshot.window = {
			since: "2026-09-08T00:00:00.000Z",
			until: "2026-09-14T23:59:59.999Z",
			timezone: "UTC",
		};
		repo.metrics.days = Object.fromEntries(dates.map((date) => [date, emptyDay()]));
		repo.coverage.commits.status = "partial";
		repo.coverage.commits.completeWindows = utcCompleteDays(
			dates.filter((date) => date !== "2026-09-10"),
		);
		const board = factoryBoard(snapshot, [repo], [repo], 30);
		expect(board.days.find((day) => day.date === "2026-09-10")?.complete.commits).toBe(false);
		expect(
			board.days
				.slice(-7)
				.filter((day) => day.date !== "2026-09-10")
				.every((day) => day.complete.commits),
		).toBe(true);
		expect(board.days.find((day) => day.date === "2026-09-10")).toMatchObject({
			observed: true,
			commits: 0,
		});
		expect(board.periods[1]?.complete.commits).toBe(false);
	});
	it("keeps an observed zero on a complete day when overall coverage is partial", () => {
		const snapshot = ready();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		snapshot.window = {
			since: "2026-10-27T16:00:00.000Z",
			until: "2026-10-28T15:59:59.999Z",
			timezone: "Asia/Shanghai",
		};
		repo.metrics.days = { "2026-10-28": emptyDay() };
		repo.coverage.commits.status = "partial";
		repo.coverage.commits.completeWindows = shanghaiCompleteDays(["2026-10-28"]);
		const board = factoryBoard(snapshot, [repo], [repo]);
		expect(board.observed.commits).toBe(true);
		expect(board.days).toHaveLength(90);
		expect(board.days.at(-1)).toMatchObject({
			date: "2026-10-28",
			observed: true,
			commits: 0,
			complete: { commits: true },
		});
		const earlier = board.days.slice(0, -1);
		expect(earlier.every((day) => !day.observed && day.commits === null)).toBe(true);
		expect(earlier.every((day) => !day.complete.commits)).toBe(true);
	});
	it("shows partial observations without claiming their days are complete", () => {
		const snapshot = ready();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		repo.coverage.commits.status = "partial";
		repo.coverage.commits.observed = 2;
		repo.metrics.days = { "2026-09-15": { ...emptyDay(), commits: 2 } };
		const board = factoryBoard(snapshot, [repo], [repo]);
		expect(board.observed.commits).toBe(true);
		expect(board.days.at(-1)).toMatchObject({ commits: 2, complete: { commits: false } });
		expect(hasFactoryMeasurement(repo, "commits")).toBe(true);
	});
	it("keeps terminal-unavailable settled windows out of measured and complete evidence", () => {
		const snapshot = ready();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		snapshot.window = {
			since: "2026-10-27T16:00:00.000Z",
			until: "2026-10-28T15:59:59.999Z",
			timezone: "Asia/Shanghai",
		};
		repo.metrics.days = { "2026-10-28": emptyDay() };
		repo.coverage.commits.status = "unavailable";
		repo.coverage.commits.observed = 0;
		repo.coverage.commits.reason = "not_found";
		repo.coverage.commits.completeWindows = shanghaiCompleteDays(["2026-10-28"]);
		repo.coverage.alerts.status = "unavailable";
		repo.coverage.alerts.observed = 0;
		repo.coverage.alerts.completeWindows = shanghaiCompleteDays(["2026-10-28"]);
		const board = factoryBoard(snapshot, [repo], [repo]);
		expect(hasFactoryMeasurement(repo, "commits")).toBe(false);
		expect(hasFactoryMeasurement(repo, "alerts")).toBe(false);
		expect(board.observed).toMatchObject({ commits: false, alerts: false });
		expect(board.days.at(-1)).toMatchObject({
			date: "2026-10-28",
			complete: { commits: false, alerts: false },
		});
		expect(factoryRepoCommits(repo, ["2026-10-28"], snapshot.window)).toEqual([null]);
		repo.coverage.commits.status = "partial";
		expect(hasFactoryMeasurement(repo, "commits")).toBe(true);
		expect(factoryBoard(snapshot, [repo], [repo]).days.at(-1)).toMatchObject({
			commits: 0,
			complete: { commits: true },
		});
		repo.coverage.commits.status = "limited";
		expect(hasFactoryMeasurement(repo, "commits")).toBe(true);
		repo.coverage.commits.status = "complete";
		expect(hasFactoryMeasurement(repo, "commits")).toBe(true);
	});
	it.each(["partial", "limited"] as const)(
		"does not assign available days from mixed %s alert settlement windows",
		(status) => {
			const snapshot = ready();
			const repo = snapshot.repos[0];
			if (!repo) throw new Error("fixture");
			snapshot.window = {
				since: "2026-10-27T16:00:00.000Z",
				until: "2026-10-29T15:59:59.999Z",
				timezone: "Asia/Shanghai",
			};
			repo.metrics.days = { "2026-10-28": emptyDay(), "2026-10-29": emptyDay() };
			repo.coverage.alerts.status = status;
			repo.coverage.alerts.observed = 1;
			repo.coverage.alerts.completeWindows = shanghaiCompleteDays(["2026-10-28", "2026-10-29"]);
			repo.coverage.commits.status = status;
			repo.coverage.commits.completeWindows = shanghaiCompleteDays(["2026-10-28"]);
			const board = factoryBoard(snapshot, [repo], [repo]);
			expect(hasFactoryMeasurement(repo, "alerts")).toBe(true);
			expect(board.observed.alerts).toBe(true);
			expect(board.days.slice(-2).map((day) => day.complete.alerts)).toEqual([false, false]);
			expect(board.days.at(-2)).toMatchObject({ commits: 0, complete: { commits: true } });
			expect(board.days.at(-1)?.complete.commits).toBe(false);
			repo.coverage.alerts.status = "complete";
			repo.coverage.alerts.observed = 2;
			const complete = factoryBoard(snapshot, [repo], [repo]);
			expect(complete.observed.alerts).toBe(true);
			expect(complete.days.slice(-2).map((day) => day.complete.alerts)).toEqual([true, true]);
		},
	);
	it("unions Asia/Shanghai day windows without crossing the local day boundary", () => {
		const snapshot = ready();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		snapshot.window = {
			since: "2026-10-26T16:00:00.000Z",
			until: "2026-10-28T15:59:59.999Z",
			timezone: "Asia/Shanghai",
		};
		repo.metrics.days = { "2026-10-27": emptyDay(), "2026-10-28": { ...emptyDay(), commits: 3 } };
		repo.coverage.commits.status = "partial";
		repo.coverage.commits.completeWindows = shanghaiCompleteDays(["2026-10-27", "2026-10-28"]);
		const board = factoryBoard(snapshot, [repo], [repo]);
		expect(board.days).toHaveLength(90);
		expect(board.days.slice(-2).map((day) => day.date)).toEqual(["2026-10-27", "2026-10-28"]);
		expect(board.days.slice(-2).every((day) => day.complete.commits)).toBe(true);
		expect(board.days.every((day) => day.timezone === "Asia/Shanghai")).toBe(true);
		expect(board.days.at(-2)).toMatchObject({ observed: true, commits: 0 });
		expect(board.days[0]).toMatchObject({ observed: false, commits: null });
		expect(board.periods[0]).toMatchObject({
			since: "2026-10-28",
			until: "2026-10-28",
			complete: { commits: true },
		});
		expect(board.periods[1]?.complete.commits).toBe(false);
	});
	it("keeps the retained observation window instead of assuming the new quick window", () => {
		const snapshot = ready();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		repo.observation = {
			version: snapshot.runId,
			window: snapshot.window,
			refreshedAt: snapshot.fetched_at,
			source: "run",
			publishedAt: snapshot.fetched_at,
		};
		snapshot.window = savedFactoryWindow(snapshot.fetched_at, 30);
		expect(factoryBoard(snapshot, snapshot.repos, snapshot.repos).days).toHaveLength(90);
	});
	it("charts retained older buckets beside updated quick-window days using the display span", () => {
		const snapshot = ready();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		repo.observation = {
			version: "quick",
			source: "run",
			window: snapshot.window,
			refreshedAt: snapshot.fetched_at,
		};
		repo.metrics.days = {
			[snapshot.window.since.slice(0, 10)]: { ...emptyDay(), commits: 2 },
			[snapshot.window.until.slice(0, 10)]: { ...emptyDay(), commits: 7 },
		};
		const board = factoryBoard(snapshot, [repo], [repo]);
		expect(board.days).toHaveLength(90);
		expect(board.days[0]?.commits).toBe(2);
		expect(board.days.at(-1)?.commits).toBe(7);
		expect(board.displayWindow.since).toBe("2026-06-18T00:00:00.000Z");
		expect(board.displayWindow.until).toBe("2026-09-16T00:00:00.000Z");
	});
	it("filters reproducibly by language, topic and repository without double counting overlapping tags", () => {
		const s = ready();
		const repo = s.repos[0];
		if (!repo) throw new Error("fixture");
		s.repos.push({
			...repo,
			id: "other",
			name: "nocoo/other",
			language: "Swift",
			topics: ["cli", "macos"],
		});
		expect(factoryGroups(s.repos).languages).toEqual(["Swift", "TypeScript"]);
		expect(
			filterFactoryRepos(s.repos, { language: "Swift", topic: "cli", query: "" }),
		).toHaveLength(1);
		expect(filterFactoryRepos(s.repos, { language: "", topic: "", query: "app" })).toHaveLength(1);
		expect(filterFactoryRepos(s.repos, { language: "", topic: "macos", query: "" })).toHaveLength(
			1,
		);
		expect(filterFactoryRepos(s.repos, { language: "", topic: "absent", query: "" })).toHaveLength(
			0,
		);
	});
	it("reports coverage and raw sample sizes, never treating unknown security as healthy", () => {
		const s = ready();
		const board = factoryBoard(s, s.repos, s.repos);
		expect(board.coverage.complete).toBe(0);
		expect(board.aggregate.ciRate).toBeNull();
		expect(board.days).toHaveLength(90);
	});
	it("requires complete dependency evidence before reporting an empty graph as zero", () => {
		const snapshot = ready();
		expect(factoryBoard(snapshot, snapshot.repos, snapshot.repos).dependenciesComplete).toBe(false);
		for (const repo of snapshot.repos) repo.coverage.dependencies.status = "complete";
		expect(factoryBoard(snapshot, snapshot.repos, snapshot.repos).dependenciesComplete).toBe(true);
		snapshot.repos = [];
		expect(factoryBoard(snapshot, [], []).dependenciesComplete).toBe(false);
	});
	it("builds only evidenced cross-project references, with source URLs and merged duplicate edges", () => {
		const s = ready();
		const repo = s.repos[0];
		if (!repo) throw new Error("fixture");
		s.repos.push({
			...repo,
			name: "nocoo/basalt",
			id: "two",
			dependencies: [],
			manifests: [
				{
					name: "@nocoo/basalt",
					version: "2",
					path: "packages/ui/package.json",
					url: "https://github.com/nocoo/basalt/blob/abc/package.json",
				},
			],
		});
		repo.dependencies = [
			{
				name: "@nocoo/basalt",
				version: "2",
				path: "package.json#dependencies",
				url: "https://github.com/nocoo/app/blob/abc/package.json",
			},
			{
				name: "@nocoo/basalt",
				version: "2",
				path: "package.json#devDependencies",
				url: "https://github.com/nocoo/app/blob/abc/package.json",
			},
		];
		expect(dependencyEdges(s.repos)[0]).toMatchObject({
			source: "nocoo/app",
			target: "nocoo/basalt",
			references: 2,
		});
		expect(dependencyEdges([])).toEqual([]);
	});
	it("filters detail rows and rejects unsafe external URLs", () => {
		expect(
			eventPage([{ title: "fix", id: "1", author: "bot", state: "open" }] as never, "fix", "open"),
		).toHaveLength(1);
		expect(eventPage([], "", "")).toEqual([]);
		expect(safeGithubUrl("javascript:alert(1)")).toBe("https://github.com");
		expect(safeGithubUrl("https://evil.test/a")).toBe("https://github.com");
		expect(safeGithubUrl("https://github.com/nocoo/app")).toBe("https://github.com/nocoo/app");
	});
});

describe("factory sampling signals", () => {
	it("computes weighted coverage, complete-day trends and inspectable anomaly rules", () => {
		const s = ready();
		const r = s.repos[0];
		if (!r) throw new Error("fixture");
		for (const c of Object.values(r.coverage)) c.status = "complete";
		Object.assign(r.metrics, {
			agedPrs: 1,
			agedIssues: 2,
			ciSuccess: 7,
			ciFailure: 3,
			alerts: 1,
			prMerged: 3,
			commits: 15,
		});
		r.metrics.days = {
			"2026-09-09": {
				commits: 10,
				issueOpened: 0,
				issueClosed: 0,
				prOpened: 0,
				prMerged: 0,
				prClosed: 0,
				ciSuccess: 0,
				ciFailure: 0,
				releases: 0,
			},
			"2026-09-02": {
				commits: 5,
				issueOpened: 0,
				issueClosed: 0,
				prOpened: 0,
				prMerged: 0,
				prClosed: 0,
				ciSuccess: 0,
				ciFailure: 0,
				releases: 0,
			},
		};
		const b = factoryBoard(s, s.repos, s.repos);
		expect(b.periods[1]).toMatchObject({
			days: 7,
			current: { commits: 10 },
			previous: { commits: 5 },
			complete: { commits: true },
			previousComplete: { commits: true },
		});
		expect(b.anomalies).toHaveLength(4);
		const second = {
			...r,
			id: "two",
			name: "nocoo/z",
			private: false,
			coverage: structuredClone(r.coverage),
			metrics: { ...r.metrics, ciSuccess: 10, ciFailure: 0, agedPrs: 0, agedIssues: 0, alerts: 0 },
		};
		second.coverage.actions.status = "limited";
		second.coverage.alerts.status = "unavailable";
		s.repos.push(second);
		const next = factoryBoard(s, s.repos, s.repos);
		expect(next.coverage.limited).toBe(1);
		expect(next.coverage.unavailable).toBe(1);
		expect(next.totals.private).toBe(1);
		expect(next.ranking.map((r) => r.name)).toEqual(["nocoo/app", "nocoo/z"]);
	});
	it("handles sparse and empty filters without substituting hidden repositories", () => {
		const s = ready();
		const r = s.repos[0];
		if (!r) throw new Error("fixture");
		r.description = null;
		expect(filterFactoryRepos(s.repos, { language: "", topic: "", query: "absent" })).toEqual([]);
		expect(filterFactoryRepos(s.repos, { language: "", topic: "", query: "" })).toHaveLength(1);
		expect(safeGithubUrl("not a URL")).toBe("https://github.com");
		expect(safeGithubUrl("https://user@github.com/nocoo/app")).toBe("https://github.com");
	});
	it("resolves workflow paths and package identities only within the observed inventory", () => {
		const s = ready();
		const r = s.repos[0];
		if (!r) throw new Error("fixture");
		s.repos.push({ ...r, name: "nocoo/base-ci", id: "b" });
		r.dependencies = [
			{
				name: "nocoo/base-ci/.github/workflows/ci.yml",
				path: ".github/workflows/ci.yml",
				version: "abc",
				url: "https://github.com/nocoo/app/blob/abc/ci.yml",
			},
			{ name: "not-in-inventory", path: "package.json#dependencies", version: "1", url: "" },
			{
				name: "nocoo/app/.github/workflows/ci.yml",
				path: ".github/workflows/ci.yml",
				version: "abc",
				url: "",
			},
		];
		expect(dependencyEdges(s.repos)).toHaveLength(1);
		expect(
			eventPage(
				[{ title: "work", id: "1", author: "human", state: "closed" }] as never,
				"",
				"open",
			),
		).toEqual([]);
		expect(
			eventPage(
				[{ title: "work", id: "1", author: "human", state: "closed" }] as never,
				"other",
				"",
			),
		).toEqual([]);
	});
});

it("exposes the published daily series for trend charts", () => {
	const s = ready();
	const days = factoryDays({
		...s,
		selectedRepos: s.repos.map((repo) => ({
			name: repo.name,
			description: repo.description,
			language: repo.language,
			topics: repo.topics,
		})),
	});
	expect(days).toHaveLength(90);
	expect(days.at(-1)?.date).toBe("2026-09-15");
});

it("resets paging when a filter changes and keeps other filters intact", () => {
	const before = new URLSearchParams("language=Swift&topic=cli&q=app&period=30&page=3");
	expect(factoryParams(before, "topic", "ui").get("page")).toBeNull();
	expect(factoryParams(before, "topic", "ui").get("language")).toBe("Swift");
	expect(factoryParams(before, "language", "").has("language")).toBe(false);
	expect(factoryParams(before, "page", "2").get("page")).toBe("2");
	expect(factoryParams(before, "period", "").has("period")).toBe(false);
});

it("keeps unknown metrics distinct from observed zero and bounds rendered repository rows", () => {
	const s = ready();
	const r = s.repos[0];
	if (!r) throw new Error("fixture");
	expect(factoryBoard(s, s.repos, s.repos).observed.commits).toBe(false);
	r.coverage.commits.status = "complete";
	r.coverage.prs.status = "limited";
	r.coverage.prs.observed = 3;
	r.coverage.releases.status = "partial";
	r.coverage.actions.status = "unavailable";
	const b = factoryBoard(s, s.repos, s.repos);
	expect(b.observed.commits).toBe(true);
	expect(b.observed.prs).toBe(true);
	expect(b.observed.releases).toBe(false);
	expect(b.observed.actions).toBe(false);
	expect(b.languages).toEqual([{ name: "TypeScript", bytes: 100, share: 1 }]);
	const many = Array.from({ length: 67 }, (_, i) => ({ ...r, id: String(i) }));
	expect(factoryRepoPage(many, 1).rows).toHaveLength(25);
	expect(factoryRepoPage(many, 999)).toMatchObject({ current: 3, pages: 3 });
	expect(factoryRepoPage(many, 3).rows).toHaveLength(17);
	expect(factoryRepoPage([], 0)).toEqual({ rows: [], current: 1, pages: 1 });
	s.repos.push({ ...r, id: "other" });
	expect(factoryBoard(s, s.repos, s.repos).languages[0]?.bytes).toBe(200);
});

it("does not invent dependency targets from ambiguous package names", () => {
	const s = ready();
	const r = s.repos[0];
	if (!r) throw new Error("fixture");
	r.dependencies = [{ name: "shared", version: "1", path: "package.json#dependencies", url: "" }];
	const dep = { name: "shared", version: "1", path: "package.json", url: "" };
	s.repos.push(
		{ ...r, id: "b", name: "nocoo/b", dependencies: [], manifests: [dep, dep] },
		{ ...r, id: "c", name: "nocoo/c", dependencies: [], manifests: [dep] },
	);
	expect(dependencyEdges(s.repos)).toEqual([]);
	expect(hasFactoryMeasurement(r, "commits")).toBe(false);
	r.coverage.commits.status = "limited";
	expect(hasFactoryMeasurement(r, "commits")).toBe(false);
	r.coverage.commits.observed = 1;
	expect(hasFactoryMeasurement(r, "commits")).toBe(true);
	r.coverage.commits.status = "complete";
	expect(hasFactoryMeasurement(r, "commits")).toBe(true);
	expect(new Set(Object.values(STREAM_CODES)).size).toBe(7);
});

it("does not divide by zero for a returned language with zero bytes", () => {
	const s = ready();
	if (s.repos[0]) s.repos[0].languages = [{ name: "Unknown", bytes: 0 }];
	expect(factoryBoard(s, s.repos, s.repos).languages[0]?.share).toBe(0);
});

it("renders lower bounds consistently for truncated commit, merged PR and release table cells", () => {
	const repo = ready().repos[0];
	if (!repo) throw new Error("fixture");
	Object.assign(repo.metrics, { commits: 12, prMerged: 3, releases: 2 });
	for (const [stream, count] of [
		["commits", 12],
		["prs", 3],
		["releases", 2],
	] as const) {
		expect(factoryRepoCount(repo, stream)).toBe("—");
		repo.coverage[stream].status = "limited";
		repo.coverage[stream].observed = 2;
		expect(factoryRepoCount(repo, stream)).toBe(`≥ ${count}`);
		repo.coverage[stream].status = "complete";
		expect(factoryRepoCount(repo, stream)).toBe(String(count));
	}
	repo.metrics.prMerged = 0;
	expect(factoryRepoCount(repo, "prs")).toBe("0");
});

it("builds mixed-window calendars from observed windows, with unknown dates rather than fabricated zeros", () => {
	const snap = ready();
	const first = snap.repos[0];
	if (!first) throw new Error("fixture");
	for (const stream of FACTORY_STREAMS) first.coverage[stream].status = "complete";
	first.observation = {
		source: "run",
		version: "old",
		refreshedAt: "2026-08-01T00:00:00Z",
		window: { since: "2026-07-01T00:00:00Z", until: "2026-08-01T00:00:00Z" },
	};
	const second = {
		...structuredClone(first),
		id: "two",
		name: "nocoo/two",
		observation: {
			...first.observation,
			version: "new",
			window: { since: "2026-08-01T00:00:00Z", until: "2026-09-01T00:00:00Z" },
		},
	};
	const board = factoryBoard(snap, [first, second], [first, second]);
	expect(board.mixedWindows).toBe(true);
	expect(board.days.at(-1)?.date).toBe("2026-08-31");
	expect(board.days.find((day) => day.date === "2026-07-01")?.complete.commits).toBe(false);
	expect(board.days.at(-1)?.complete.commits).toBe(false);
	const single = factoryBoard(snap, [first], [first]);
	expect(single.days.at(-1)?.complete.commits).toBe(true);
	expect(single.displayWindow.until).toBe("2026-08-01T00:00:00.000Z");
	first.observation.window = { since: "2000-01-01T00:00:00Z", until: "2000-02-01T00:00:00Z" };
	expect(factoryBoard(snap, [first, second], [first, second]).days.length).toBeLessThanOrEqual(366);
});

function utcDates(start: string, count: number) {
	return Array.from({ length: count }, (_, index) =>
		new Date(Date.parse(`${start}T00:00:00.000Z`) + index * 86_400_000).toISOString().slice(0, 10),
	);
}
function utcCompleteDays(dates: readonly string[]) {
	return dates.map((date) => ({
		since: `${date}T00:00:00.000Z`,
		until: `${date}T23:59:59.999Z`,
		timezone: "UTC",
	}));
}
function shanghaiCompleteDays(dates: readonly string[]) {
	return dates.map((date) => ({
		since: `${date}T00:00:00.000+08:00`,
		until: `${date}T23:59:59.999+08:00`,
		timezone: "Asia/Shanghai",
	}));
}
function day(commits: number, extra: Partial<Record<"prMerged" | "releases", number>> = {}) {
	return {
		commits,
		issueOpened: 0,
		issueClosed: 0,
		prOpened: 0,
		prMerged: extra.prMerged ?? 0,
		prClosed: 0,
		ciSuccess: 0,
		ciFailure: 0,
		releases: extra.releases ?? 0,
	};
}

it("reads relative activity age from the snapshot clock, not the viewer clock", () => {
	expect(activityAge("2026-09-15", "2026-09-15T22:00:00Z")).toBe("今天");
	expect(activityAge("2026-09-14", "2026-09-15T22:00:00Z")).toBe("昨天");
	expect(activityAge("2026-09-01", "2026-09-15T22:00:00Z")).toBe("14 天前");
	expect(activityAge(undefined, "2026-09-15T22:00:00Z")).toBe("窗口内无提交");
});

function withDays(name: string, days: Record<string, ReturnType<typeof day>>) {
	const repo = structuredClone(ready().repos[0]);
	if (!repo) throw new Error("fixture");
	for (const stream of FACTORY_STREAMS) repo.coverage[stream].status = "complete";
	repo.id = name;
	repo.name = `nocoo/${name}`;
	repo.metrics.days = days;
	return repo;
}

it("compares 1, 7 and 30 complete UTC days with the preceding equal period", () => {
	const s = ready();
	const hot = withDays("hot", {
		"2026-09-14": { ...day(4, { prMerged: 1, releases: 1 }), issueOpened: 3, issueClosed: 1 },
		"2026-09-13": day(2),
		"2026-09-05": day(5),
		"2026-08-20": day(7),
		"2026-08-01": day(9),
		"2026-09-15": day(99),
	});
	hot.metrics.days["2026-09-12"] = { ...day(0), ciSuccess: 3, ciFailure: 1 };
	const quiet = withDays("quiet", { "2026-09-13": day(1) });
	s.repos = [hot, quiet];
	const [d1, d7, d30] = factoryBoard(s, s.repos, s.repos).periods;
	expect(d1).toMatchObject({
		days: 1,
		since: "2026-09-14",
		until: "2026-09-14",
		current: { commits: 4, prMerged: 1, releases: 1, issueOpened: 3, issueClosed: 1, active: 1 },
		previous: { commits: 3, active: 2 },
	});
	expect(d7?.current).toMatchObject({ commits: 7, ciSuccess: 3, ciFailure: 1, active: 2 });
	expect(d7?.previous).toMatchObject({ commits: 5, active: 1 });
	expect(d30?.current.commits).toBe(19);
	expect(d30?.previous.commits).toBe(9);
	expect(d30?.complete.commits).toBe(true);
	quiet.coverage.issues.status = "limited";
	quiet.observation = {
		source: "run",
		version: "v",
		refreshedAt: "2026-09-15T00:00:00Z",
		window: { since: "2026-08-20T00:00:00Z", until: "2026-09-15T22:00:00Z" },
	};
	const behind = structuredClone(quiet);
	behind.id = "behind";
	behind.name = "nocoo/behind";
	behind.observation = {
		source: "run",
		version: "v",
		refreshedAt: "2026-09-14T23:00:00Z",
		window: { since: "2026-06-16T00:00:00Z", until: "2026-09-14T23:00:00Z" },
	};
	const shifted = factoryBoard(s, [hot, behind], [hot, behind]);
	expect(shifted.periods[0]).toMatchObject({
		since: "2026-09-13",
		until: "2026-09-13",
		complete: { commits: true },
	});
	expect(shifted.repoActivity[0]?.periods[1].commits).toBe(2);
	const partial = factoryBoard(s, s.repos, s.repos).periods;
	expect(partial[0]?.complete).toMatchObject({ commits: true, issues: false });
	expect(partial[2]?.complete.commits).toBe(false);
	expect(partial[1]?.previousComplete.commits).toBe(true);
	expect(factoryBoard(s, [], []).periods[0]?.complete.commits).toBe(false);
});

it("summarizes each repository per period with stock, aged work and last commit", () => {
	const s = ready();
	const repo = withDays("app", {
		"2026-09-14": { ...day(2, { prMerged: 1 }), issueOpened: 1, issueClosed: 2 },
		"2026-09-02": day(6),
		"2026-07-01": day(1),
	});
	Object.assign(repo, { openIssues: 5, openPrs: 2 });
	Object.assign(repo.metrics, { agedIssues: 3, agedPrs: 1 });
	const blind = withDays("blind", {});
	blind.coverage.commits.status = "pending";
	blind.coverage.issues.status = "partial";
	s.repos = [repo, blind];
	const [app, other] = factoryBoard(s, s.repos, s.repos).repoActivity;
	expect(app).toMatchObject({
		name: "nocoo/app",
		last: "2026-09-14",
		previous7: 6,
		openIssues: 5,
		openPrs: 2,
		agedIssues: 3,
		agedPrs: 1,
		known: { commits: true, issues: true, prs: true },
	});
	expect(app?.periods[1]).toMatchObject({
		commits: 2,
		prMerged: 1,
		issueOpened: 1,
		issueClosed: 2,
	});
	expect(app?.periods[7].commits).toBe(2);
	expect(app?.periods[30].commits).toBe(8);
	expect(other).toMatchObject({ agedIssues: null, known: { commits: false, issues: false } });
	expect(other?.last).toBeUndefined();
	expect(factoryBoard(s, s.repos, s.repos).activity).toEqual({
		week: 1,
		month: 0,
		dormant: 0,
		unknown: 1,
	});
});

it("reconstructs open backlog backwards from the current count and rolls 7-day breadth and CI rate", () => {
	const s = ready();
	const a = withDays("a", {
		"2026-09-15": { ...day(1), issueOpened: 2, issueClosed: 0, prOpened: 1 },
		"2026-09-14": { ...day(1), issueOpened: 0, issueClosed: 3, ciSuccess: 3, ciFailure: 1 },
		"2026-09-10": { ...day(2), ciSuccess: 1 },
	});
	Object.assign(a, { openIssues: 4, openPrs: 1 });
	const b = withDays("b", { "2026-09-13": day(1), "2026-09-01": day(1) });
	Object.assign(b, { openIssues: 0, openPrs: 0 });
	s.repos = [a, b];
	const days = factoryBoard(s, s.repos, s.repos).days;
	const at = (date: string) => days.find((d) => d.date === date);
	expect(at("2026-09-15")).toMatchObject({ openIssues: 4, openPrs: 1, activeRepos7: 2 });
	expect(at("2026-09-14")).toMatchObject({ openIssues: 2, openPrs: 0, ciRate7: 0.8 });
	expect(at("2026-09-13")?.openIssues).toBe(5);
	expect(at("2026-09-08")?.activeRepos7).toBe(0);
	expect(at("2026-09-07")?.activeRepos7).toBe(1);
	expect(at("2026-09-08")?.ciRate7).toBeNull();
	expect(days[0]?.activeRepos7).toBeNull();
	const d1 = factoryBoard(s, s.repos, s.repos).periods[0];
	expect(d1?.stock).toEqual({ openIssues: { from: 5, to: 2 }, openPrs: { from: 0, to: 0 } });
	a.openIssues = 0;
	expect(
		factoryBoard(s, s.repos, s.repos).days.find((d) => d.date === "2026-09-13")?.openIssues,
	).toBeNull();
	expect(factoryBoard(s, s.repos, s.repos).periods[0]?.stock.openIssues).toEqual({
		from: null,
		to: null,
	});
	a.coverage.issues.status = "limited";
	b.coverage.actions.status = "pending";
	const blind = factoryBoard(s, s.repos, s.repos).days;
	expect(blind.every((d) => d.openIssues === null && d.ciRate7 === null)).toBe(true);
	expect(blind.at(-1)?.openPrs).toBe(1);
});

it("ranks accumulated work with aged share and recent throughput", () => {
	const s = ready();
	const heavy = withDays("heavy", { "2026-09-01": { ...day(0), issueClosed: 4, prMerged: 2 } });
	Object.assign(heavy, { openIssues: 6, openPrs: 1 });
	Object.assign(heavy.metrics, { agedIssues: 2, agedPrs: 1 });
	const light = withDays("light", {});
	Object.assign(light, { openIssues: 1, openPrs: 0 });
	light.coverage.issues.status = "limited";
	const clear = withDays("clear", {});
	Object.assign(clear, { openIssues: 0, openPrs: 0 });
	s.repos = [light, clear, heavy];
	const backlog = backlogRows(factoryBoard(s, s.repos, s.repos).repoActivity);
	expect(backlog.rows.map((r) => [r.name, r.total, r.done30])).toEqual([
		["nocoo/heavy", 7, 6],
		["nocoo/light", 1, null],
	]);
	expect(backlog.rows[1]?.agedIssues).toBeNull();
	expect(backlog).toMatchObject({ openIssues: 7, openPrs: 1, aged: null, clear: 1, max: 7 });
	expect(backlogRows([]).max).toBe(1);
	const tie = withDays("aa", {});
	Object.assign(tie, { openIssues: 7, openPrs: 0 });
	s.repos = [heavy, tie];
	expect(
		backlogRows(factoryBoard(s, s.repos, s.repos).repoActivity).rows.map((r) => r.name),
	).toEqual(["nocoo/aa", "nocoo/heavy"]);
});

it("splits repositories into activity and backlog quadrants around medians", () => {
	const s = ready();
	const repos = [3, 0, 10, 40].map((commits, i) => {
		const r = withDays(`r${i}`, commits ? { "2026-09-01": day(commits) } : {});
		r.openIssues = [5, 2, 0, 1][i] ?? 0;
		r.openPrs = 0;
		return r;
	});
	const blind = withDays("blind", {});
	blind.coverage.commits.status = "pending";
	s.repos = [...repos, blind];
	const q = activityQuadrant(factoryBoard(s, s.repos, s.repos).repoActivity);
	expect(q.points.map((p) => p.name)).toEqual(["nocoo/r0", "nocoo/r1", "nocoo/r2", "nocoo/r3"]);
	expect(q.medianCommits).toBe(6.5);
	expect(q.medianBacklog).toBe(1.5);
	expect(q.stalled.map((p) => p.name)).toEqual(["nocoo/r0", "nocoo/r1"]);
	expect(activityQuadrant([])).toMatchObject({ points: [], medianCommits: 0, medianBacklog: 0 });
	s.repos = repos.slice(0, 3);
	expect(activityQuadrant(factoryBoard(s, s.repos, s.repos).repoActivity).medianCommits).toBe(3);
});

describe("grouped inspection signals", () => {
	const signal = (
		repo: string,
		label: string,
		stream: "prs" | "issues" | "actions" | "alerts",
	) => ({
		repo,
		label,
		stream,
	});

	it("collects one group per repository, heaviest and then alphabetical", () => {
		const groups = factorySignalGroups([
			signal("nocoo/b", "1 个 open PR ≥7 天", "prs"),
			signal("nocoo/a", "2 个 open issue ≥14 天", "issues"),
			signal("nocoo/a", "CI 失败 3/10", "actions"),
			signal("nocoo/c", "1 个开放依赖告警", "alerts"),
		]);
		expect(groups.map((g) => g.repo)).toEqual(["nocoo/a", "nocoo/b", "nocoo/c"]);
		expect(groups[0]?.signals.map((s) => s.label)).toEqual([
			"2 个 open issue ≥14 天",
			"CI 失败 3/10",
		]);
		expect(factorySignalGroups([])).toEqual([]);
	});

	it("pages groups without dropping the signal total", () => {
		const groups = factorySignalGroups(
			Array.from({ length: 8 }, (_, i) => signal(`nocoo/r${i}`, "1 个 open PR ≥7 天", "prs")),
		);
		const first = factorySignalPage(groups, 1);
		expect(first).toMatchObject({ current: 1, pages: 2, signals: 8, groups: 8 });
		expect(first.rows.map((g) => g.repo)).toHaveLength(6);
		expect(factorySignalPage(groups, 2).rows.map((g) => g.repo)).toEqual(["nocoo/r6", "nocoo/r7"]);
		expect(factorySignalPage(groups, 99).current).toBe(2);
		expect(factorySignalPage(groups, 0).current).toBe(1);
		expect(factorySignalPage([], 3)).toMatchObject({ rows: [], current: 1, pages: 1, signals: 0 });
	});
});

it("describes change against the previous period without inventing a baseline", () => {
	expect(periodChange(12, 10)).toEqual({ label: "+20%", direction: "up" });
	expect(periodChange(5, 10)).toEqual({ label: "-50%", direction: "down" });
	expect(periodChange(10, 10)).toEqual({ label: "持平", direction: "flat" });
	expect(periodChange(3, 0)).toEqual({ label: "新增", direction: "up" });
	expect(periodChange(0, 0)).toEqual({ label: "—", direction: "flat" });
	expect(periodChange(0.9, 0.85, "rate")).toEqual({ label: "+5.0pp", direction: "up" });
	expect(periodChange(null, 0.85, "rate")).toEqual({ label: "—", direction: "flat" });
	expect(periodChange(0.8, 0.9, "rate")).toEqual({ label: "-10.0pp", direction: "down" });
	expect(periodChange(0.9, 0.9, "rate")).toEqual({ label: "+0.0pp", direction: "flat" });
	expect(periodChange(37, -12, "delta")).toEqual({ label: "+49", direction: "up" });
	expect(periodChange(-5, 3, "delta")).toEqual({ label: "-8", direction: "down" });
	expect(periodChange(2, 2, "delta")).toEqual({ label: "持平", direction: "flat" });
});
