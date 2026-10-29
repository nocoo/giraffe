// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { emptyDay } from "../../lib/factory";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import { factoryBoard, factoryGroups, filterFactoryRepos } from "./factory";

function fixture() {
	const snapshot = factoryFixture();
	const repo = snapshot.repos[0];
	if (!repo) throw new Error("missing fixture publication");
	for (const stream of FACTORY_STREAMS) repo.coverage[stream].status = "complete";
	repo.observation = {
		source: "run",
		version: "published",
		window: snapshot.window,
		refreshedAt: snapshot.fetched_at,
	};
	snapshot.contributionStatus = "complete";
	snapshot.inventory.complete = true;
	repo.metrics.commits = 3;
	const selectedRepos = [
		{
			name: repo.name,
			description: repo.description,
			language: repo.language,
			topics: repo.topics,
		},
		{ name: "nocoo/missing", description: "Unpublished", language: "Swift", topics: null },
	];
	return { ...snapshot, selectedRepos };
}

it("keeps unpublished selection in coverage, days, periods, exact series and health", () => {
	const snapshot = fixture();
	const board = factoryBoard(snapshot, snapshot.repos, snapshot.selectedRepos);
	expect(board.coverage).toMatchObject({ complete: 7, total: 14 });
	expect(board.totals.repos).toBe(2);
	expect(board.freshness).toEqual({
		oldestAt: snapshot.fetched_at,
		latestAt: snapshot.fetched_at,
		total: 2,
		missing: 1,
	});
	expect(board.days.every((day) => FACTORY_STREAMS.every((stream) => !day.complete[stream]))).toBe(
		true,
	);
	for (const period of board.periods) {
		expect(Object.values(period.complete).every((complete) => !complete)).toBe(true);
		expect(Object.values(period.previousComplete).every((complete) => !complete)).toBe(true);
		expect(period.stock.openIssues).toEqual({ from: null, to: null });
	}
	expect(board.days.every((day) => day.activeRepos7 === null && day.ciRate7 === null)).toBe(true);
	expect(board.aggregate.commits).toBe(3);
	expect(board.ranking).toEqual(snapshot.repos);
	expect(snapshot.repos).toHaveLength(1);
});

it("draws historical coverage lines for the published starred selection and withholds them for an unpublished star", () => {
	const snapshot = fixture();
	const repo = snapshot.repos[0];
	if (!repo) throw new Error("missing fixture publication");
	repo.metrics.days = {
		"2026-09-15": { ...emptyDay(), commits: 2, ciSuccess: 4, ciFailure: 1, issueOpened: 1 },
	};
	const starred = filterFactoryRepos(snapshot.selectedRepos, {
		language: "",
		topic: "",
		query: "nocoo/app",
	});
	const published = factoryBoard(snapshot, snapshot.repos, starred);
	expect(published.days.slice(1).every((day) => day.complete.commits)).toBe(true);
	expect(published.days.at(-1)).toMatchObject({
		activeRepos7: 1,
		ciRate7: 0.8,
		openIssues: 1,
		openPrs: 1,
	});
	expect(published.periods[1]?.complete.commits).toBe(true);
	const blocked = factoryBoard(snapshot, snapshot.repos, snapshot.selectedRepos);
	expect(blocked.days.at(-1)).toMatchObject({
		activeRepos7: null,
		ciRate7: null,
		openIssues: null,
		openPrs: null,
	});
});

it("filters expected membership before joining publications, retaining unknown topics", () => {
	const snapshot = fixture();
	const filter = { language: "", topic: "", query: "" };
	for (const [query, names] of [
		[{ query: "nocoo/app" }, ["nocoo/app"]],
		[{ query: "Unpublished" }, ["nocoo/missing"]],
		[{ language: "Swift" }, ["nocoo/missing"]],
		[{ query: "Unpublished" }, ["nocoo/missing"]],
		[{ topic: "cli" }, ["nocoo/app", "nocoo/missing"]],
	] as const) {
		const selected = filterFactoryRepos(snapshot.selectedRepos, { ...filter, ...query });
		expect(selected.map((repo) => repo.name)).toEqual(names);
		const observed = snapshot.repos.filter((repo) =>
			selected.some((member) => member.name === repo.name),
		);
		const board = factoryBoard(snapshot, observed, selected);
		expect(board.coverage.total).toBe(names.length * 7);
		expect(board.freshness.missing).toBe(names.some((name) => name === "nocoo/missing") ? 1 : 0);
	}
	const selected = filterFactoryRepos(snapshot.selectedRepos, { ...filter, query: "nocoo/app" });
	const board = factoryBoard(snapshot, snapshot.repos, selected);
	expect(board.coverage).toMatchObject({ complete: 7, total: 7 });
	expect(board.freshness.missing).toBe(0);
	expect(board.days.every((day) => day.complete.commits)).toBe(true);
	expect(factoryGroups(snapshot.selectedRepos)).toEqual({
		languages: ["Swift", "TypeScript"],
		topics: ["cli"],
	});
});

it("does not fabricate observations or timestamps for an entirely unpublished filtered selection", () => {
	const snapshot = fixture();
	const selected = snapshot.selectedRepos.slice(1);
	const board = factoryBoard(snapshot, [], selected);
	expect(board.coverage).toMatchObject({ complete: 0, total: 7 });
	expect(board.freshness).toEqual({ oldestAt: null, latestAt: null, total: 1, missing: 1 });
	expect(board.observed.commits).toBe(false);
	expect(board.ranking).toEqual([]);
	expect(board.repoActivity).toEqual([]);
	expect(board.days.every((day) => !day.complete.commits && day.openIssues === null)).toBe(true);
});
