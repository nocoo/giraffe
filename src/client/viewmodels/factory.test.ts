// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { factoryFixture as ready } from "../../../tests/fixtures/factory-snapshot";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import {
	activityAge,
	dependencyEdges,
	eventPage,
	factoryBoard,
	factoryGroups,
	factoryParams,
	factoryRepoCount,
	factoryRepoPage,
	filterFactoryRepos,
	hasFactoryMeasurement,
	STREAM_CODES,
	safeGithubUrl,
} from "./factory";

describe("software factory view model", () => {
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
			filterFactoryRepos(s.repos, { language: "Swift", topic: "cli", query: "", repo: "" }),
		).toHaveLength(1);
		expect(
			filterFactoryRepos(s.repos, { language: "", topic: "", query: "app", repo: "" }),
		).toHaveLength(1);
		expect(
			filterFactoryRepos(s.repos, { language: "", topic: "macos", query: "", repo: "nocoo/app" }),
		).toHaveLength(0);
	});
	it("reports coverage and raw sample sizes, never treating unknown security as healthy", () => {
		const s = ready();
		const board = factoryBoard(s, s.repos);
		expect(board.coverage.complete).toBe(0);
		expect(board.securityKnown).toBe(0);
		expect(board.aggregate.ciRate).toBeNull();
		expect(board.days).toHaveLength(90);
	});
	it("builds only evidenced cross-project references, with source URLs and merged duplicate edges", () => {
		const s = ready();
		const repo = s.repos[0];
		if (!repo) throw new Error("fixture");
		s.repos.push({
			...repo,
			name: "nocoo/basalt",
			id: "two",
			dependencies: [
				{
					name: "@nocoo/basalt",
					version: "2",
					path: "package.json#name",
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
		const b = factoryBoard(s, s.repos);
		expect(b.pulse.commits).toEqual({ recent: 10, previous: 5, complete: true });
		expect(b.anomalies).toHaveLength(4);
		expect(b.securityKnown).toBe(1);
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
		const next = factoryBoard(s, s.repos);
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
		expect(
			filterFactoryRepos(s.repos, { language: "", topic: "", query: "absent", repo: "" }),
		).toEqual([]);
		expect(
			filterFactoryRepos(s.repos, { language: "", topic: "", query: "", repo: r.name }),
		).toHaveLength(1);
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

it("changes drilldown parameters atomically without reverting the selected tab", () => {
	const before = new URLSearchParams("repo=nocoo/app&stream=prs&state=open&day=2026-09-01&page=2");
	const next = factoryParams(before, "stream", "commits");
	expect(next.get("stream")).toBe("commits");
	expect(next.has("state")).toBe(false);
	expect(next.has("day")).toBe(false);
	expect(next.has("page")).toBe(false);
	expect(factoryParams(before, "language", "Swift").has("repo")).toBe(false);
	expect(factoryParams(before, "repo", "").has("repo")).toBe(false);
	expect(factoryParams(before, "page", "3").get("page")).toBe("3");
	expect(before.get("stream")).toBe("prs");
});

it("keeps unknown metrics distinct from observed zero and bounds rendered repository rows", () => {
	const s = ready();
	const r = s.repos[0];
	if (!r) throw new Error("fixture");
	expect(factoryBoard(s, s.repos).observed.commits).toBe(false);
	r.coverage.commits.status = "complete";
	r.coverage.prs.status = "limited";
	r.coverage.prs.observed = 3;
	r.coverage.releases.status = "partial";
	r.coverage.actions.status = "unavailable";
	const b = factoryBoard(s, s.repos);
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
	expect(factoryBoard(s, s.repos).languages[0]?.bytes).toBe(200);
});

it("does not invent dependency targets from ambiguous package names", () => {
	const s = ready();
	const r = s.repos[0];
	if (!r) throw new Error("fixture");
	r.dependencies = [{ name: "shared", version: "1", path: "package.json#dependencies", url: "" }];
	const dep = { name: "shared", version: "1", path: "package.json#name", url: "" };
	s.repos.push(
		{ ...r, id: "b", name: "nocoo/b", dependencies: [dep, dep] },
		{ ...r, id: "c", name: "nocoo/c", dependencies: [dep] },
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
	expect(factoryBoard(s, s.repos).languages[0]?.share).toBe(0);
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
	const board = factoryBoard(snap, [first, second]);
	expect(board.mixedWindows).toBe(true);
	expect(board.days[0]?.date).toBe("2026-07-01");
	expect(board.days[0]?.complete.commits).toBe(false);
	expect(board.days.at(-1)?.complete.commits).toBe(false);
	const single = factoryBoard(snap, [first]);
	expect(single.days[0]?.complete.commits).toBe(true);
	expect(single.displayWindow.until).toBe("2026-08-01T00:00:00.000Z");
	first.observation.window = { since: "2000-01-01T00:00:00Z", until: "2000-02-01T00:00:00Z" };
	expect(factoryBoard(snap, [first, second]).days.length).toBeLessThanOrEqual(366);
});

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

it("summarizes the last seven complete UTC days as a portfolio pulse without inventing unknown activity", () => {
	const s = ready();
	const base = s.repos[0];
	if (!base) throw new Error("fixture");
	for (const stream of FACTORY_STREAMS) base.coverage[stream].status = "complete";
	const hot = {
		...structuredClone(base),
		id: "hot",
		name: "nocoo/hot",
	};
	hot.metrics.days = {
		"2026-09-14": day(8, { prMerged: 2, releases: 1 }),
		"2026-09-08": day(3),
		"2026-09-15": day(50),
	};
	const cooling = {
		...structuredClone(base),
		id: "cool",
		name: "nocoo/cool",
	};
	cooling.metrics.days = { "2026-09-05": day(6), "2026-08-01": day(9) };
	const idle = { ...structuredClone(base), id: "idle", name: "nocoo/idle" };
	idle.metrics.days = { "2026-07-01": day(2) };
	const unknown = { ...structuredClone(base), id: "unknown", name: "nocoo/unknown" };
	unknown.coverage.commits.status = "pending";
	unknown.metrics.days = { "2026-09-14": day(4) };
	s.repos = [hot, cooling, idle, unknown];
	const pulse = factoryBoard(s, s.repos).pulse;
	expect(pulse.range).toEqual({ since: "2026-09-08", until: "2026-09-14" });
	expect(pulse.commits).toEqual({ recent: 15, previous: 6, complete: false });
	expect(pulse.prMerged).toBe(2);
	expect(pulse.releases).toBe(1);
	expect(pulse.active).toEqual({ week: 1, month: 1, dormant: 1, unknown: 1 });
	expect(pulse.movers.map((m) => [m.name, m.recent, m.previous])).toEqual([["nocoo/hot", 11, 0]]);
	expect(pulse.cooling.map((m) => m.name)).toEqual(["nocoo/cool"]);
	expect(pulse.lastCommit.get("nocoo/hot")).toBe("2026-09-15");
	expect(pulse.lastCommit.get("nocoo/idle")).toBe("2026-07-01");
	const complete = factoryBoard(s, [hot, cooling, idle]).pulse;
	expect(complete.commits.complete).toBe(true);
	cooling.observation = {
		source: "run",
		version: "v",
		refreshedAt: "2026-09-14T22:00:00Z",
		window: { since: "2026-06-17T00:00:00Z", until: "2026-09-14T22:00:00Z" },
	};
	expect(factoryBoard(s, [hot, cooling, idle]).pulse.commits.complete).toBe(false);
	cooling.observation.window.until = "2026-09-15T00:00:00Z";
	expect(factoryBoard(s, [hot, cooling, idle]).pulse.commits.complete).toBe(true);
	cooling.observation.window.since = "2026-09-02T00:00:00Z";
	expect(factoryBoard(s, [hot, cooling, idle]).pulse.commits.complete).toBe(false);
	delete cooling.observation;
	expect(complete.active).toEqual({ week: 1, month: 1, dormant: 1, unknown: 0 });
	expect(factoryBoard(s, []).pulse).toMatchObject({ movers: [], commits: { complete: false } });
});

it("reads relative activity age from the snapshot clock, not the viewer clock", () => {
	expect(activityAge("2026-09-15", "2026-09-15T22:00:00Z")).toBe("今天");
	expect(activityAge("2026-09-14", "2026-09-15T22:00:00Z")).toBe("昨天");
	expect(activityAge("2026-09-01", "2026-09-15T22:00:00Z")).toBe("14 天前");
	expect(activityAge(undefined, "2026-09-15T22:00:00Z")).toBe("窗口内无提交");
});
