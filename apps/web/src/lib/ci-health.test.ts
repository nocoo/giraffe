import { afterEach, describe, expect, it, vi } from "vitest";
import { type CiRun, ciReport, classifyStream, releaseHealth, workflowName } from "./ci-health";

const NOW = "2026-09-18T12:00:00Z";
let seq = 0;
const run = (conclusion: string | null, at: string, over: Partial<CiRun> = {}): CiRun => ({
	id: ++seq,
	name: "CI",
	html_url: `https://github.com/a/b/actions/runs/${seq}`,
	status: conclusion === null ? "in_progress" : "completed",
	conclusion,
	event: "push",
	head_branch: "main",
	created_at: at,
	updated_at: at,
	...over,
});

describe("classify one workflow stream", () => {
	it("flags a streak of consecutive failures since the last success", () => {
		const s = classifyStream(
			[
				run("failure", "2026-09-18T10:00:00Z"),
				run("cancelled", "2026-09-18T09:00:00Z"),
				run("failure", "2026-09-17T10:00:00Z"),
				run("success", "2026-09-16T10:00:00Z"),
				run("success", "2026-09-15T10:00:00Z"),
			],
			NOW,
		);
		expect(s).toMatchObject({
			verdict: "broken",
			brokenBy: "streak",
			streak: 2,
			failingSince: "2026-09-17T10:00:00Z",
			lastSuccess: "2026-09-16T10:00:00Z",
			decided: 4,
			failures: 2,
		});
		expect(s.recent.map((r) => r.outcome)).toEqual([
			"failure",
			"other",
			"failure",
			"success",
			"success",
		]);
	});

	it("treats a single latest failure as flaky, not broken", () => {
		const s = classifyStream(
			[run("failure", "2026-09-18T10:00:00Z"), run("success", "2026-09-17T10:00:00Z")],
			NOW,
		);
		expect(s).toMatchObject({
			verdict: "flaky",
			streak: 1,
			reason: "最近一次失败",
			recurring: false,
		});
	});

	it("marks recovered but unstable streams as flaky and clean ones healthy", () => {
		const flaky = classifyStream(
			[
				run("success", "2026-09-18T10:00:00Z"),
				run("failure", "2026-09-17T10:00:00Z"),
				run("success", "2026-09-16T10:00:00Z"),
				run("success", "2026-09-15T10:00:00Z"),
			],
			NOW,
		);
		expect(flaky).toMatchObject({
			verdict: "flaky",
			streak: 0,
			failures: 1,
			flips: 2,
			recurring: false,
		});
		const recurring = classifyStream(
			[
				run("success", "2026-09-18T10:00:00Z"),
				run("failure", "2026-09-17T10:00:00Z"),
				run("success", "2026-09-16T10:00:00Z"),
				run("failure", "2026-09-15T10:00:00Z"),
				run("success", "2026-09-14T10:00:00Z"),
			],
			NOW,
		);
		expect(recurring).toMatchObject({ verdict: "flaky", failures: 2, recurring: true });
		expect(flaky.reason).toBe("近 4 次判定失败 1 次");
		const healthy = classifyStream(
			[run("success", "2026-09-18T10:00:00Z"), run("skipped", "2026-09-17T10:00:00Z")],
			NOW,
		);
		expect(healthy).toMatchObject({ verdict: "healthy", failures: 0, rate: 1 });
	});

	it("ignores failures older than the observation window and reports idle streams", () => {
		const old = classifyStream(
			[run("success", "2026-09-10T00:00:00Z"), run("failure", "2026-07-01T00:00:00Z")],
			NOW,
		);
		expect(old.verdict).toBe("healthy");
		const idle = classifyStream([run("failure", "2026-07-01T00:00:00Z")], NOW);
		expect(idle).toMatchObject({ verdict: "idle", reason: "14 天没有运行" });
		const pending = classifyStream([run(null, "2026-09-18T10:00:00Z")], NOW);
		expect(pending).toMatchObject({ verdict: "idle", pending: 1 });
	});

	it("treats a latest completed success as recovered despite chronic historical failure", () => {
		const outcomes = [
			"success",
			"failure",
			"failure",
			"success",
			"failure",
			"failure",
			"success",
			"failure",
		];
		const s = classifyStream(
			outcomes.map((o, i) => run(o, `2026-09-${String(17 - i).padStart(2, "0")}T10:00:00Z`)),
			NOW,
		);
		expect(s).toMatchObject({
			verdict: "flaky",
			streak: 0,
			failures: 5,
			reason: "近 8 次判定失败 5 次",
			brokenBy: null,
			recurring: true,
		});
		const few = classifyStream(
			[
				run("success", "2026-09-17T10:00:00Z"),
				run("failure", "2026-09-16T10:00:00Z"),
				run("failure", "2026-09-15T10:00:00Z"),
			],
			NOW,
		);
		expect(few).toMatchObject({ verdict: "flaky", recurring: true });
		const thin = classifyStream(
			[
				run("failure", "2026-09-17T10:00:00Z"),
				run("success", "2026-09-16T10:00:00Z"),
				run("success", "2026-09-15T10:00:00Z"),
			],
			NOW,
		);
		expect(thin.verdict).toBe("flaky");
	});

	it("uses only completed runs as decisive evidence during reruns", () => {
		const s = classifyStream(
			[
				run("failure", "2026-09-18T11:00:00Z", { status: "in_progress" }),
				run("success", "2026-09-18T10:00:00Z"),
				run("failure", "2026-09-17T10:00:00Z"),
				run("failure", "2026-09-16T10:00:00Z"),
			],
			NOW,
		);
		expect(s).toMatchObject({ verdict: "flaky", streak: 0, decided: 3, failures: 2, pending: 1 });
		expect(s.recent[0]?.outcome).toBe("pending");
	});

	it("keeps chronic failure broken only while the latest decisive run is failing", () => {
		const s = classifyStream(
			["failure", "success", "failure", "failure"].map((outcome, i) =>
				run(outcome, `2026-09-${18 - i}T10:00:00Z`),
			),
			NOW,
		);
		expect(s).toMatchObject({ verdict: "broken", streak: 1, brokenBy: "chronic", failures: 3 });
	});

	it("becomes idle at exactly 14 days without a run, not just after the 30-day window", () => {
		const older = run("failure", "2026-09-03T12:00:00Z");
		const boundary = classifyStream([run("failure", "2026-09-04T12:00:00Z"), older], NOW);
		expect(boundary).toMatchObject({
			verdict: "idle",
			reason: "14 天没有运行",
			brokenBy: null,
			failures: 2,
		});
		expect(classifyStream([run("failure", "2026-09-04T12:00:00.001Z"), older], NOW).verdict).toBe(
			"broken",
		);
		expect(classifyStream([run("success", "2026-09-04T12:00:00Z")], NOW).verdict).toBe("idle");
	});

	it("says when a single failed run is all the evidence there is", () => {
		const s = classifyStream([run("failure", "2026-09-17T10:00:00Z")], NOW);
		expect(s).toMatchObject({ verdict: "flaky", reason: "仅 1 次判定且失败，样本不足" });
	});

	it("counts timed-out and startup failures as failures", () => {
		const s = classifyStream(
			[run("timed_out", "2026-09-18T10:00:00Z"), run("startup_failure", "2026-09-17T10:00:00Z")],
			NOW,
		);
		expect(s).toMatchObject({ verdict: "broken", streak: 2, lastSuccess: null });
	});
});

describe("workflow identity", () => {
	it("folds per-run numbering and Dependabot update jobs into stable workflow names", () => {
		expect(workflowName({ name: "Deploy CI 35224235217", event: "push" })).toBe("Deploy CI");
		expect(
			workflowName({ name: "npm_and_yarn in /. - Update #1587070115", event: "dynamic" }),
		).toBe("Dependabot 更新任务");
		expect(workflowName({ name: "Release #12", event: "push" })).toBe("Release");
		expect(workflowName({ name: "CI", event: "push" })).toBe("CI");
		expect(workflowName({ name: "", event: "push" })).toBe("未命名工作流");
	});

	it("keeps Dependabot jobs out of the repository verdict", () => {
		const report = ciReport(
			[
				{
					repo: "a/bot",
					fetched_at: NOW,
					default_branch: "main",
					truncated: false,
					runs: [
						run("failure", "2026-09-18T10:00:00Z", { name: "x - Update #1", event: "dynamic" }),
						run("failure", "2026-09-17T10:00:00Z", { name: "y - Update #2", event: "dynamic" }),
						run("success", "2026-09-18T09:00:00Z"),
					],
				},
			],
			NOW,
		);
		expect(report.streams.map((s) => [s.workflow, s.scope, s.verdict])).toEqual([
			["Dependabot 更新任务", "bot", "broken"],
			["CI", "main", "healthy"],
		]);
		expect(report.repos[0]).toMatchObject({
			verdict: "healthy",
			brokenWorkflows: 0,
			botStreams: 1,
		});
		expect(report.totals.brokenWorkflows).toBe(0);
	});
});

describe("repository and account report", () => {
	it("splits streams by workflow and branch and ranks broken first", () => {
		const report = ciReport(
			[
				{
					repo: "a/one",
					fetched_at: NOW,
					default_branch: "main",
					truncated: false,
					runs: [
						run("failure", "2026-09-18T10:00:00Z", { name: "Release" }),
						run("failure", "2026-09-17T10:00:00Z", { name: "Release" }),
						run("success", "2026-09-18T11:00:00Z"),
						run("failure", "2026-09-18T09:00:00Z", { head_branch: "feat" }),
						run("success", "2026-09-17T09:00:00Z", { head_branch: "feat" }),
					],
				},
				{
					repo: "a/two",
					fetched_at: NOW,
					default_branch: "main",
					truncated: true,
					runs: [run("success", "2026-09-18T10:00:00Z")],
				},
				{ repo: "a/none", fetched_at: NOW, truncated: false, runs: [] },
			],
			NOW,
		);
		expect(report.streams.map((s) => [s.repo, s.workflow, s.branch, s.verdict])).toEqual([
			["a/one", "Release", "main", "broken"],
			["a/one", "CI", "feat", "flaky"],
			["a/one", "CI", "main", "healthy"],
			["a/two", "CI", "main", "healthy"],
		]);
		const green = ciReport(
			[
				{
					repo: "a/g",
					fetched_at: NOW,
					default_branch: "main",
					truncated: false,
					runs: [
						run("success", "2026-09-18T10:00:00Z", { head_branch: "chore/deps" }),
						run("success", "2026-09-18T09:00:00Z"),
					],
				},
			],
			NOW,
		);
		expect(green.streams.map((s) => s.branch)).toEqual(["main", "chore/deps"]);
		expect(
			report.repos.map((r) => [r.repo, r.verdict, r.brokenWorkflows, r.flakyWorkflows]),
		).toEqual([
			["a/one", "broken", 1, 0],
			["a/two", "healthy", 0, 0],
			["a/none", "none", 0, 0],
		]);
		expect(report.totals).toMatchObject({
			brokenWorkflows: 1,
			flakyWorkflows: 0,
			healthyWorkflows: 2,
			idleWorkflows: 0,
			brokenRepos: 1,
			healthyRepos: 1,
			unknownRepos: 1,
			totalRepos: 3,
			truncatedRepos: 1,
			nonDefaultBranchStreams: 1,
			nonDefaultBranchFailures: 1,
		});
		expect(report.daily.at(-1)).toMatchObject({ x: "2026-09-18", success: 2, failure: 2 });
		expect(report.daily).toHaveLength(30);
	});
});

describe("report edge cases", () => {
	afterEach(() => vi.useRealTimers());

	it.each([
		"pull_request",
		"pull_request_target",
		"pull_request_review",
		"pull_request_review_comment",
	])("keeps %s runs observational when their branch name matches the default", (event) => {
		const report = ciReport(
			[
				{
					repo: "owner/app",
					default_branch: "main",
					fetched_at: NOW,
					truncated: false,
					runs: [
						run("success", "2026-09-18T09:00:00Z"),
						run("failure", "2026-09-18T10:00:00Z", { event }),
						run("failure", "2026-09-18T11:00:00Z", { event }),
					],
				},
			],
			NOW,
		);
		expect(report.repos[0]).toMatchObject({ verdict: "healthy", totalWorkflows: 1 });
		expect(report.totals).toMatchObject({
			brokenWorkflows: 0,
			healthyWorkflows: 1,
			nonDefaultBranchStreams: 1,
			nonDefaultBranchFailures: 2,
		});
		expect(report.streams.map((stream) => [stream.scope, stream.branch])).toEqual([
			["branch", "main"],
			["main", "main"],
		]);
		expect(report.daily.at(-1)).toMatchObject({ success: 1, failure: 2 });
	});

	it("does not infer a default branch from main, tag names or null refs", () => {
		const report = ciReport(
			[
				...([undefined, "", "trunk"] as const).map((branch, i) => ({
					repo: `a/unknown-${i}`,
					fetched_at: NOW,
					truncated: false,
					...(branch === undefined ? {} : { default_branch: branch }),
					runs: ["main", "v1.2.3", null].flatMap((head_branch) => [
						run("failure", "2026-09-18T10:00:00Z", { head_branch }),
						run("failure", "2026-09-17T10:00:00Z", { head_branch }),
					]),
				})),
			],
			NOW,
		);
		expect(report.streams).toHaveLength(9);
		expect(report.streams.every((s) => s.scope === "branch")).toBe(true);
		expect(report.repos.every((r) => r.verdict === "none")).toBe(true);
		expect(report.totals).toMatchObject({
			brokenWorkflows: 0,
			brokenRepos: 0,
			unknownRepos: 3,
			totalWorkflows: 0,
			nonDefaultBranchStreams: 9,
			nonDefaultBranchFailures: 18,
		});
	});

	it("counts default-branch workflows, repositories and observational failed runs separately", () => {
		const report = ciReport(
			[
				{
					repo: "a/broken",
					fetched_at: NOW,
					default_branch: "main",
					truncated: false,
					runs: ["CI", "Build"].flatMap((name) => [
						run("failure", "2026-09-18T10:00:00Z", { name }),
						run("failure", "2026-09-17T10:00:00Z", { name }),
					]),
				},
				{
					repo: "a/healthy",
					fetched_at: NOW,
					default_branch: "main",
					truncated: false,
					runs: [
						run("success", "2026-09-18T10:00:00Z"),
						...Array.from({ length: 3 }, (_, i) =>
							run("failure", `2026-09-${17 - i}T10:00:00Z`, { head_branch: "deleted/pr" }),
						),
						run("failure", "2026-07-01T00:00:00Z", { head_branch: "deleted/pr" }),
						run("failure", "2026-09-18T11:00:00Z", {
							head_branch: "deleted/pr",
							status: "queued",
						}),
					],
				},
			],
			NOW,
		);
		expect(report.repos.find((r) => r.repo === "a/healthy")).toMatchObject({
			verdict: "healthy",
			brokenWorkflows: 0,
			totalWorkflows: 1,
			nonDefaultBranchStreams: 1,
			nonDefaultBranchFailures: 3,
		});
		expect(report.totals).toEqual({
			brokenWorkflows: 2,
			flakyWorkflows: 0,
			healthyWorkflows: 1,
			idleWorkflows: 0,
			recurringWorkflows: 0,
			brokenRepos: 1,
			flakyRepos: 0,
			healthyRepos: 1,
			idleRepos: 0,
			unknownRepos: 0,
			totalRepos: 2,
			totalWorkflows: 3,
			nonDefaultBranchStreams: 1,
			nonDefaultBranchFailures: 3,
			botStreams: 0,
			truncatedRepos: 0,
		});
		for (const old of [
			"broken",
			"flaky",
			"healthy",
			"idle",
			"recurring",
			"repos",
			"bot",
			"truncated",
		])
			expect(report.totals).not.toHaveProperty(old);
		for (const old of ["broken", "flaky", "healthy", "idle", "streams", "bot"])
			expect(report.repos[0]).not.toHaveProperty(old);
	});

	it("uses the saved observation reference instead of the GET wall clock", () => {
		const entries = [
			{
				repo: "a/one",
				fetched_at: NOW,
				default_branch: "main",
				truncated: false,
				runs: [run("failure", "2026-09-18T10:00:00Z"), run("failure", "2026-09-17T10:00:00Z")],
			},
		];
		vi.useFakeTimers();
		vi.setSystemTime("2026-09-18T12:00:00Z");
		const before = ciReport(entries, NOW);
		vi.setSystemTime("2027-01-01T00:00:00Z");
		expect(ciReport(entries, NOW)).toEqual(before);
		expect(before.repos[0]?.verdict).toBe("broken");
	});

	it("keeps repository and stream order stable and tolerates idle-only and odd refs", () => {
		const report = ciReport(
			[
				{
					repo: "b/idle",
					fetched_at: NOW,
					default_branch: "main",
					truncated: false,
					runs: [run("success", "2026-07-01T00:00:00Z")],
				},
				{
					repo: "a/multi",
					fetched_at: NOW,
					truncated: false,
					default_branch: "trunk",
					runs: [
						run("success", "2026-09-18T10:00:00Z", { name: "Lint", head_branch: "trunk" }),
						run("success", "2026-09-18T10:00:00Z", { name: "Build", head_branch: null }),
						run("success", "2026-09-17T10:00:00Z", { name: "Build", head_branch: "v1.2.0" }),
						run("failure", "2026-09-18T10:00:00Z", { name: "Build", head_branch: "fix/a" }),
						run("failure", "2026-09-18T10:00:00Z", { name: "Build", head_branch: "fix/b" }),
						run("success", "2026-06-01T00:00:00Z", { name: "Build" }),
					],
				},
				{
					repo: "c/branch-only",
					fetched_at: NOW,
					default_branch: "main",
					truncated: false,
					runs: [run("failure", "2026-09-18T10:00:00Z", { head_branch: "wip" })],
				},
			],
			NOW,
		);
		expect(report.streams.map((s) => [s.repo, s.workflow, s.branch])).toEqual([
			["a/multi", "Build", "fix/a"],
			["a/multi", "Build", "fix/b"],
			["c/branch-only", "CI", "wip"],
			["a/multi", "Lint", "trunk"],
			["a/multi", "Build", null],
			["a/multi", "Build", "v1.2.0"],
			["b/idle", "CI", "main"],
			["a/multi", "Build", "main"],
		]);
		expect(report.repos.map((r) => [r.repo, r.verdict])).toEqual([
			["a/multi", "healthy"],
			["b/idle", "idle"],
			["c/branch-only", "none"],
		]);
		expect(report.repos.find((r) => r.repo === "b/idle")?.lastRun).toBe("2026-07-01T00:00:00Z");
		expect(report.daily.every((d) => d.x >= "2026-08-20")).toBe(true);
		const tie = ciReport(
			[
				{
					repo: "z/b",
					fetched_at: NOW,
					default_branch: "main",
					truncated: false,
					runs: [run("success", "2026-09-18T10:00:00Z")],
				},
				{
					repo: "z/a",
					fetched_at: NOW,
					default_branch: "main",
					truncated: false,
					runs: [run("success", "2026-09-18T10:00:00Z")],
				},
			],
			NOW,
		);
		expect(tie.repos.map((r) => r.repo)).toEqual(["z/a", "z/b"]);
		const same = classifyStream(
			[
				run("success", "2026-09-18T10:00:00Z", { id: 1 }),
				run("failure", "2026-09-18T10:00:00Z", { id: 2 }),
			],
			NOW,
		);
		expect(same.recent.map((r) => r.id)).toEqual([2, 1]);
	});
});

describe("release health", () => {
	it("reports age, cadence and whether the latest release run failed", () => {
		const rel = (tag: string, at: string | null, draft = false) => ({
			id: seq++,
			tag_name: tag,
			name: null,
			html_url: "",
			draft,
			prerelease: false,
			published_at: at,
		});
		const r = releaseHealth(
			[
				rel("v3", "2026-09-17T00:00:00Z"),
				rel("v2", "2026-09-10T00:00:00Z"),
				rel("v1", "2026-09-01T00:00:00Z"),
				rel("d", null, true),
			],
			{ verdict: "broken", streak: 2 },
			NOW,
		);
		expect(r).toMatchObject({
			latest: "v3",
			ageDays: 1,
			cadenceDays: 8,
			count: 3,
			pipeline: "broken",
			recent30: 3,
		});
		const even = releaseHealth(
			[
				rel("b", "2026-09-17T00:00:00Z"),
				rel("a", "2026-09-13T00:00:00Z"),
				rel("0", "2026-09-11T00:00:00Z"),
				rel("x", "2026-09-01T00:00:00Z"),
			],
			null,
			NOW,
		);
		expect(even.cadenceDays).toBe(4);
		expect(releaseHealth([], null, NOW)).toMatchObject({
			latest: null,
			ageDays: null,
			cadenceDays: null,
			pipeline: "none",
		});
	});
});
