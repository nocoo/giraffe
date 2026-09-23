// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CiReportResponse } from "../../lib/ci-health";
import { ciBuckets, ciFilterStreams, loadCi, releaseRows } from "./ci";
import { setActiveAccountId } from "./session";

const stream = (repo: string, verdict: string, over: Record<string, unknown> = {}) =>
	({
		repo,
		workflow: "CI",
		branch: "main",
		scope: "main",
		verdict,
		reason: "",
		streak: 0,
		failingSince: null,
		lastSuccess: null,
		lastRun: "2026-09-18T00:00:00Z",
		decided: 10,
		failures: 0,
		rate: 1,
		flips: 0,
		recurring: false,
		brokenBy: null,
		pending: 0,
		recent: [],
		...over,
	}) as CiReportResponse["streams"][number];

describe("ci viewmodel", () => {
	afterEach(() => {
		setActiveAccountId(null);
		vi.unstubAllGlobals();
	});

	it("groups streams into act-now, watch and stable lanes", () => {
		const streams = [
			stream("a/1", "broken", { streak: 3 }),
			stream("a/2", "flaky", { recurring: true, failures: 3 }),
			stream("a/3", "flaky", { failures: 1 }),
			stream("a/4", "healthy"),
			stream("a/5", "idle"),
			stream("a/6", "broken", { scope: "branch", branch: "feat" }),
			stream("a/7", "broken", { scope: "bot", workflow: "Dependabot 更新任务" }),
		];
		const b = ciBuckets(streams);
		expect(b.act.map((s) => s.repo)).toEqual(["a/1", "a/6"]);
		expect(b.watch.map((s) => s.repo)).toEqual(["a/2", "a/3"]);
		expect(b.stable.map((s) => s.repo)).toEqual(["a/4"]);
		expect(b.idle).toBe(1);
		expect(b.bot.map((s) => s.repo)).toEqual(["a/7"]);
	});

	it("filters streams by verdict, repository and text", () => {
		const streams = [
			stream("nocoo/app", "broken", { workflow: "Release" }),
			stream("nocoo/app", "healthy"),
			stream("nocoo/web", "flaky", { recurring: true }),
		];
		expect(ciFilterStreams(streams, { verdict: "broken", repo: "", query: "" })).toHaveLength(1);
		expect(ciFilterStreams(streams, { verdict: "recurring", repo: "", query: "" })).toHaveLength(1);
		expect(ciFilterStreams(streams, { verdict: "", repo: "nocoo/app", query: "" })).toHaveLength(2);
		expect(ciFilterStreams(streams, { verdict: "", repo: "", query: "rel" })).toHaveLength(1);
		expect(ciFilterStreams(streams, { verdict: "", repo: "", query: "WEB" })).toHaveLength(1);
	});

	it("orders releases by pipeline risk and then by staleness", () => {
		const repo = (name: string, pipeline: string, ageDays: number | null) =>
			({
				repo: name,
				verdict: "healthy",
				release: {
					latest: ageDays === null ? null : "v1",
					latestAt: null,
					ageDays,
					cadenceDays: 7,
					count: 1,
					recent30: 1,
					pipeline,
					pipelineStreak: 0,
				},
			}) as unknown as CiReportResponse["repos"][number];
		const cadence = (name: string, age: number, days: number | null) => {
			const r = repo(name, "healthy", age);
			(r.release as { cadenceDays: number | null }).cadenceDays = days;
			return r;
		};
		expect(
			releaseRows([
				cadence("a/slow", 70, null),
				cadence("a/weekly", 40, 7),
				cadence("a/tie", 40, 7),
			]).map((r) => [r.repo, r.stale]),
		).toEqual([
			["a/tie", true],
			["a/weekly", true],
			["a/slow", false],
		]);
		const rows = releaseRows([
			repo("a/fresh", "healthy", 1),
			repo("a/old", "healthy", 120),
			repo("a/broken", "broken", 3),
			repo("a/never", "none", null),
			{ ...repo("a/none", "none", null), release: null },
		]);
		expect(rows.map((r) => r.repo)).toEqual(["a/broken", "a/old", "a/fresh", "a/never"]);
		expect(rows[1]).toMatchObject({ stale: true });
		expect(rows[2]).toMatchObject({ stale: false });
	});

	it("loads the report for the active account only", async () => {
		setActiveAccountId("acct");
		const body = { account_id: "acct", streams: [], repos: [] };
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				String(url).endsWith("/api/accounts")
					? Response.json({ accounts: [{ id: "acct", login: "n", is_active: true }] })
					: Response.json(body),
			),
		);
		expect(await loadCi()).toEqual(body);
	});
});
