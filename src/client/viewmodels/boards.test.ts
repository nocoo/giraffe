import { describe, expect, it } from "vitest";
import {
	alertsBoard,
	inboxBoard,
	mergedHistory,
	primaryOwner,
	pullsBoard,
	repoActivityBoard,
	repoFactorySeries,
	reposBoard,
	workBoard,
} from "./boards";

const NOW = "2026-09-18T12:00:00Z";
const issue = (
	repo: string,
	created: string,
	labels: string[] = [],
	comments = 0,
	author = "nocoo",
) => ({
	name_with_owner: repo,
	number: 1,
	title: "t",
	url: "",
	created_at: created,
	updated_at: created,
	author_login: author,
	labels: labels.map((name) => ({ name, color: "000" })),
	comments_count: comments,
});

describe("work item boards", () => {
	it("summarizes open work by age, repository, label and author with filters applied", () => {
		const rows = [
			issue("a/x", "2026-09-18T01:00:00Z", ["bug"], 2),
			issue("a/x", "2026-09-10T00:00:00Z", ["bug", "ui"]),
			issue("a/y", "2026-06-01T00:00:00Z", [], 0, "bot"),
		];
		const board = workBoard(rows, NOW, { repo: "", label: "", author: "", age: "" });
		expect(board.total).toBe(3);
		expect(board.age.rows.map((r) => r.count)).toEqual([1, 0, 1, 0, 1]);
		expect(board.repos.rows[0]).toMatchObject({ name: "a/x", value: 2 });
		expect(board.repoCount).toBe(2);
		expect(board.labels.rows.map((r) => r.name)).toEqual(["bug", "ui", "未标记"]);
		expect(board.authors.rows[0]).toMatchObject({ name: "nocoo", value: 2 });
		expect(board.medianAge).toBe(8);
		expect(board.stale).toBe(1);
		expect(board.discussed).toBe(1);
		expect(board.weekly.at(-1)).toEqual({ x: "09-14", y: 1 });
		const filtered = workBoard(rows, NOW, { repo: "a/x", label: "ui", author: "", age: "" });
		expect(filtered.rows).toHaveLength(1);
		expect(filtered.repos.rows[0]?.value).toBe(1);
		expect(workBoard(rows, NOW, { repo: "", label: "", author: "", age: "old" }).rows).toHaveLength(
			1,
		);
		expect(workBoard(rows, NOW, { repo: "", label: "", author: "bot", age: "" }).rows).toHaveLength(
			1,
		);
		const { comments_count: _drop, ...bare } = issue("a/z", "bad-date");
		const orphan = { ...bare, author_login: null };
		const unknown = workBoard([orphan], NOW, { repo: "", label: "", author: "未知", age: "" });
		expect(unknown.rows).toHaveLength(1);
		expect(unknown.authors.rows[0]?.name).toBe("未知");
		expect(unknown.discussed).toBe(0);
		expect(
			workBoard([orphan], NOW, { repo: "", label: "", author: "", age: "d1" }).rows,
		).toHaveLength(0);
		expect(workBoard([], NOW, { repo: "", label: "", author: "", age: "" })).toMatchObject({
			total: 0,
			medianAge: null,
		});
	});

	it("adds review state and change size to pull request boards", () => {
		const pr = (review: string | null, draft: boolean, add: number, del: number) => ({
			...issue("a/x", "2026-09-17T00:00:00Z"),
			is_draft: draft,
			review_decision: review as never,
			additions: add,
			deletions: del,
			base_ref: "main",
			head_ref: "f",
		});
		const board = pullsBoard(
			[
				pr("APPROVED", false, 10, 2),
				pr(null, true, 500, 100),
				pr("CHANGES_REQUESTED", false, 0, 0),
				pr(null, false, 60, 0),
				pr("REVIEW_REQUIRED", false, 1, 1),
			],
			NOW,
			{ repo: "", label: "", author: "", age: "", review: "" },
		);
		expect(board.review.map((r) => [r.key, r.value])).toEqual([
			["draft", 1],
			["required", 1],
			["changes", 1],
			["approved", 1],
			["none", 1],
		]);
		expect(board.sizes.map((r) => r.value)).toEqual([2, 2, 0, 1]);
		expect(board.churn).toEqual({ additions: 571, deletions: 103 });
		expect(
			pullsBoard([pr("APPROVED", false, 1, 1)], NOW, {
				repo: "",
				label: "",
				author: "",
				age: "",
				review: "draft",
			}).rows,
		).toHaveLength(0);
	});
});

describe("merged pull request history", () => {
	it("sums recent merged, opened and closed PRs per day and per repository from factory metrics", () => {
		const day = (prMerged: number, prOpened = 0, prClosed = 0) => ({
			commits: 0,
			issueOpened: 0,
			issueClosed: 0,
			prOpened,
			prMerged,
			prClosed,
			ciSuccess: 0,
			ciFailure: 0,
			releases: 0,
		});
		const repo = (
			name: string,
			days: Record<string, ReturnType<typeof day>>,
			cycle: number[] = [],
		) => ({
			name,
			metrics: { days, cycleHours: cycle },
		});
		const history = mergedHistory(
			[
				repo(
					"a/x",
					{ "2026-09-18": day(2, 3), "2026-09-10": day(1, 0, 1), "2026-07-01": day(9) },
					[1, 3],
				),
				repo("a/y", { "2026-09-17": day(4) }, [10]),
			],
			NOW,
			14,
		);
		expect(history.merged).toBe(7);
		expect(history.opened).toBe(3);
		expect(history.closed).toBe(1);
		expect(history.daily.at(-1)).toEqual({ x: "2026-09-18", merged: 2, opened: 3 });
		expect(history.daily).toHaveLength(14);
		expect(history.repos.rows.map((r) => [r.name, r.value])).toEqual([
			["a/y", 4],
			["a/x", 3],
		]);
		expect(history.cycleHours).toBe(3);
		expect(mergedHistory([], NOW, 7)).toMatchObject({ merged: 0, cycleHours: null });
	});
});

describe("single repository factory series", () => {
	it("fills every day of the window and marks days outside it as unknown", () => {
		const day = (commits: number) => ({
			commits,
			issueOpened: 1,
			issueClosed: 0,
			prOpened: 0,
			prMerged: 2,
			prClosed: 0,
			ciSuccess: 3,
			ciFailure: 1,
			releases: 0,
		});
		const series = repoFactorySeries(
			{ metrics: { days: { "2026-09-17": day(4), "2026-09-15": day(1) } } },
			{ since: "2026-09-15T00:00:00Z", until: "2026-09-17T08:00:00Z" },
		);
		expect(series.map((d) => [d.x, d.commits, d.prMerged, d.issueOpened])).toEqual([
			["2026-09-15", 1, 2, 1],
			["2026-09-16", 0, 0, 0],
			["2026-09-17", 4, 2, 1],
		]);
		expect(series[0]?.ciRate).toBe(0.75);
		expect(series[1]?.ciRate).toBe(0.75);
		expect(
			repoFactorySeries(
				{ metrics: { days: {} } },
				{ since: "2026-09-15T00:00:00Z", until: "2026-09-15T08:00:00Z" },
			)[0]?.ciRate,
		).toBeNull();
		expect(repoFactorySeries({ metrics: { days: {} } }, { since: "x", until: "y" })).toEqual([]);
	});
});

describe("inbox and alerts boards", () => {
	it("groups notifications by reason, repository and day, separating own from external repositories", () => {
		const n = (repo: string, reason: string, at: string, unread = true) => ({
			id: `${repo}${at}${reason}`,
			unread,
			reason,
			updated_at: at,
			title: "t",
			url: "",
			name_with_owner: repo,
		});
		const rows = [
			n("nocoo/a", "author", "2026-09-18T01:00:00Z"),
			n("nocoo/a", "comment", "2026-09-17T01:00:00Z", false),
			n("other/b", "subscribed", "2026-09-18T02:00:00Z"),
		];
		const board = inboxBoard(rows, NOW, "nocoo", { reason: "", repo: "", unread: "" });
		expect(board.unread).toBe(2);
		expect(board.external).toBe(1);
		expect(board.reasons.rows.map((r) => r.name)).toEqual(["author", "comment", "subscribed"]);
		expect(board.daily.keys).toEqual(["author", "comment", "subscribed"]);
		expect(board.daily.points.at(-1)).toMatchObject({ total: 2, author: 1, subscribed: 1 });
		expect(
			inboxBoard(rows, NOW, "nocoo", { reason: "subscribed", repo: "", unread: "" }).rows,
		).toHaveLength(1);
		expect(
			inboxBoard(rows, NOW, "nocoo", { reason: "", repo: "", unread: "read" }).rows,
		).toHaveLength(1);
		expect(
			inboxBoard(rows, NOW, "nocoo", { reason: "", repo: "", unread: "unread" }).rows,
		).toHaveLength(2);
		expect(inboxBoard(rows, NOW, null, { reason: "", repo: "", unread: "" }).external).toBe(0);
		expect(primaryOwner(rows)).toBe("nocoo");
		expect(primaryOwner([])).toBeNull();
		expect(primaryOwner([{ name_with_owner: "solo" }])).toBe("solo");
	});

	it("ranks alerts by severity and repository", () => {
		const a = (repo: string, severity: string, source = "dependabot") => ({
			name_with_owner: repo,
			source,
			severity,
			summary: "",
			url: "",
		});
		const board = alertsBoard(
			[
				a("x/a", "high"),
				a("x/a", "critical"),
				a("x/b", "LOW", "code_scanning"),
				a("x/b", "weird"),
				a("x/c", "moderate"),
			],
			{
				severity: "",
				repo: "",
				source: "",
			},
		);
		expect(board.severity.map((r) => [r.key, r.value])).toEqual([
			["critical", 1],
			["high", 1],
			["medium", 1],
			["low", 1],
			["other", 1],
		]);
		expect(board.repos.rows[0]).toMatchObject({ name: "x/a", value: 2 });
		expect(board.sources.rows.map((r) => r.name)).toEqual(["dependabot", "code_scanning"]);
		expect(
			alertsBoard([a("x/a", "high")], { severity: "high", repo: "", source: "" }).rows,
		).toHaveLength(1);
		expect(
			alertsBoard([a("x/a", "high")], { severity: "low", repo: "", source: "" }).rows,
		).toHaveLength(0);
	});
});

describe("repository boards", () => {
	const repo = (over: Record<string, unknown>) => ({
		name_with_owner: "nocoo/a",
		name: "a",
		owner_login: "nocoo",
		description: null,
		stargazer_count: 0,
		fork_count: 0,
		open_issue_count: 0,
		primary_language: "TypeScript",
		pushed_at: "2026-09-18T00:00:00Z",
		visibility: "PUBLIC",
		is_private: false,
		is_archived: false,
		is_fork: false,
		url: "",
		...over,
	});

	it("summarizes the catalog by status, language, freshness and popularity", () => {
		const rows = [
			repo({ stargazer_count: 5, open_issue_count: 2 }),
			repo({
				name_with_owner: "nocoo/b",
				is_fork: true,
				primary_language: null,
				pushed_at: "2020-01-01T00:00:00Z",
			}),
			repo({
				name_with_owner: "nocoo/c",
				is_archived: true,
				visibility: "PRIVATE",
				is_private: true,
			}),
			repo({ name_with_owner: "nocoo/d", statistics_enabled: false }),
			repo({ name_with_owner: "nocoo/0", stargazer_count: 5 }),
		];
		const board = reposBoard(rows, NOW, { language: "", status: "", age: "" });
		expect(board.status.map((s) => [s.key, s.value])).toEqual([
			["active", 2],
			["disabled", 1],
			["fork", 1],
			["archived", 1],
		]);
		expect(board.languages.rows[0]).toMatchObject({ name: "TypeScript", value: 4 });
		expect(board.freshness.rows.map((r) => r.count)).toEqual([4, 0, 0, 0, 1]);
		expect(board.freshness.unknown).toBe(0);
		expect(board.stars.rows.map((r) => r.name)).toEqual(["nocoo/0", "nocoo/a"]);
		expect(board.privateCount).toBe(1);
		expect(reposBoard(rows, NOW, { language: "未标记", status: "", age: "" }).rows).toHaveLength(1);
		expect(reposBoard(rows, NOW, { language: "", status: "archived", age: "" }).rows).toHaveLength(
			1,
		);
		expect(reposBoard(rows, NOW, { language: "", status: "", age: "old" }).rows).toHaveLength(1);
	});

	it("describes a repository's actions, releases and traffic as dated series", () => {
		const run = (conclusion: string | null, at: string, name = "CI", start = at, end = at) => ({
			id: 1,
			name,
			html_url: "",
			status: conclusion ? "completed" : "in_progress",
			conclusion,
			event: "push",
			head_branch: "main",
			created_at: start,
			updated_at: end,
		});
		const board = repoActivityBoard(
			{
				runs: [
					run(
						"success",
						"2026-09-18T01:00:00Z",
						"CI",
						"2026-09-18T01:00:00Z",
						"2026-09-18T01:05:00Z",
					),
					run("failure", "2026-09-17T01:00:00Z"),
					run(null, "2026-09-18T02:00:00Z", "Release"),
					run("cancelled", "2026-09-16T01:00:00Z"),
				],
				releases: [
					{
						id: 1,
						tag_name: "v2",
						name: null,
						html_url: "",
						draft: false,
						prerelease: false,
						published_at: "2026-09-18T00:00:00Z",
					},
					{
						id: 2,
						tag_name: "v1",
						name: null,
						html_url: "",
						draft: false,
						prerelease: true,
						published_at: "2026-09-08T00:00:00Z",
					},
					{
						id: 3,
						tag_name: "v0",
						name: null,
						html_url: "",
						draft: true,
						prerelease: false,
						published_at: null,
					},
				],
			},
			NOW,
		);
		expect(board.ci).toMatchObject({ success: 1, failure: 1, other: 1, pending: 1, rate: 0.5 });
		expect(board.ci.daily.points.at(-1)).toMatchObject({ x: "2026-09-18", success: 1, pending: 1 });
		expect(board.workflows.rows.map((r) => r.name)).toEqual(["CI", "Release"]);
		expect(board.ci.medianMinutes).toBe(5);
		expect(board.releases).toMatchObject({
			published: 2,
			prerelease: 1,
			draft: 1,
			cadenceDays: 10,
		});
		expect(board.releases.timeline.map((t) => t.tag)).toEqual(["v1", "v2"]);
		const empty = repoActivityBoard({ runs: [], releases: [] }, NOW);
		expect(empty.ci).toMatchObject({ rate: null, medianMinutes: null });
		expect(empty.releases.cadenceDays).toBeNull();
	});
});
