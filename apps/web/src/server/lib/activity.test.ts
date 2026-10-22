import { expect, it } from "vitest";
import { rawRepo } from "../../../../../tests/fixtures/factory";
import { makeRun } from "../../lib/factory-run";
import { FACTORY_STREAMS, type FactoryStreamData } from "../../lib/factory-types";
import {
	activityRepo,
	activityTotals,
	activityWindow,
	isActivityRun,
	isDeployWorkflow,
} from "./activity";
import { mapFactoryEvents, mapFactoryRepo } from "./factory-map";

const until = "2026-10-22T20:00:00.000Z";
const run = () =>
	makeRun(
		"r2",
		"account_123",
		"nocoo",
		"key",
		"refresh",
		[],
		until,
		[],
		[],
		{ scope: "all" },
		"quick",
	);
it("R4 uses only daily or all-scope quick predecessors, never arbitrary selected runs", () => {
	const current = run();
	expect(isActivityRun(current)).toBe(true);
	current.selection = { scope: "selected", repos: ["nocoo/a", "nocoo/b"] };
	expect(isActivityRun(current)).toBe(false);
	current.trigger = "daily";
	expect(isActivityRun(current)).toBe(true);
	current.depth = "deep";
	expect(isActivityRun(current)).toBe(false);
});
it("R4 freezes seamless windows from pre-migration successes and marks Beijing gaps without jitter", () => {
	const current = run();
	const first = activityWindow(current, null, false);
	expect(first).toEqual({ since: "2026-10-21T20:00:00.000Z", until, gap: true, first: true });
	const previous = {
		...run(),
		id: "r1",
		window: { since: "old", until: "2026-10-21T19:00:00.000Z" },
	};
	expect(activityWindow(current, previous, false)).toEqual({
		since: previous.window.until,
		until,
		gap: false,
		first: false,
	});
	expect(activityWindow(current, previous, true).gap).toBe(true);
	previous.window.until = "2026-10-20T20:00:00.000Z";
	expect(activityWindow(current, previous, false).gap).toBe(true);
});
it.each([
	"deploy.yml",
	".github/workflows/release.yml",
	"Publish package",
	"pages-build-deployment",
])("R4 classifies deploy workflows without repository exceptions: %s", (name) => {
	expect(isDeployWorkflow(name)).toBe(true);
	expect(isDeployWorkflow("test-ci.yml")).toBe(false);
});
it("R4 slices enriched 90-day lists with exclusive since, inclusive until and nullable coverage", () => {
	const repo = mapFactoryRepo(rawRepo);
	const data = new Map<string, FactoryStreamData>();
	for (const stream of FACTORY_STREAMS) {
		repo.coverage[stream].status = "complete";
		data.set(stream, {
			runId: "r2",
			items: [],
			next: null,
			ranges: [],
			coverage: repo.coverage[stream],
		});
	}
	const at = "2026-10-22T10:00:00.000Z";
	const prs = data.get("prs");
	const actions = data.get("actions");
	if (!prs || !actions) throw new Error("fixture");
	prs.items = mapFactoryEvents("prs", [
		{
			id: 1,
			node_id: "P1",
			created_at: at,
			merged_at: until,
			closed_at: until,
			user: { login: "dependabot[bot]", type: "Bot" },
			base: { ref: "main" },
			merged_by: { login: "nocoo" },
			state: "closed",
			labels: [{ name: "dependencies" }],
		},
	]);
	actions.items = mapFactoryEvents("actions", [
		{
			id: 42,
			workflow_id: 9,
			name: "Deploy",
			created_at: until,
			updated_at: until,
			run_started_at: "2026-10-22T19:59:00.000Z",
			head_branch: "main",
			event: "push",
			head_sha: "abc",
			run_attempt: 2,
			status: "completed",
			conclusion: "failure",
			actor: { login: "nocoo" },
		},
	]);
	const window = { since: "2026-10-21T20:00:00.000Z", until, gap: false, first: false };
	const activity = activityRepo(repo, data, window, null, null);
	expect(activity.prs.merged?.[0]).toMatchObject({
		merged_by: "nocoo",
		base_ref: "main",
		dependency: true,
		bot: true,
	});
	expect(activity.ci_runs?.[0]).toMatchObject({
		id: 42,
		workflow_id: 9,
		event: "push",
		is_default_branch: true,
		run_attempt: 2,
		duration_s: 60,
	});
	expect(activity.snapshot.code_scanning).toBeNull();
	expect(activity.commits.other).toBeNull();
	expect(activityTotals([activity])).toMatchObject({
		ci_runs: 1,
		merged_prs: 1,
		dependency_prs: 1,
		other_prs: 0,
	});
	prs.coverage.status = "unavailable";
	expect(activityRepo(repo, data, window, null, null).prs.merged).toBeNull();
});
it("R4 incomplete lists never become complete zero totals or current open snapshots", () => {
	const repo = mapFactoryRepo(rawRepo);
	const data = new Map<string, FactoryStreamData>();
	for (const stream of FACTORY_STREAMS)
		data.set(stream, {
			runId: "r2",
			items: [],
			next: null,
			ranges: [],
			coverage: { ...repo.coverage[stream], status: "limited" },
		});
	const activity = activityRepo(
		repo,
		data,
		{ since: "2026-10-21T20:00:00.000Z", until, gap: false, first: false },
		null,
		null,
	);
	expect(activity.prs.merged).toEqual([]);
	expect(activity.snapshot.open_prs).toBeNull();
	expect(activity.snapshot.open_issues).toBeNull();
	expect(activity.commits.default).toBeNull();
	expect(activityTotals([activity])).toMatchObject({
		ci_runs: null,
		merged_prs: null,
		issues_opened: null,
		releases: null,
	});
});

it("R4 includes old still-open PRs/issues, issue classes and feature-specific security nulls", () => {
	const repo = mapFactoryRepo(rawRepo);
	const data = new Map<string, FactoryStreamData>();
	for (const stream of FACTORY_STREAMS)
		data.set(stream, {
			runId: "r2",
			items: [],
			next: null,
			ranges: [],
			coverage: { ...repo.coverage[stream], status: "complete" },
		});
	const prs = data.get("prs"),
		issues = data.get("issues"),
		commits = data.get("commits"),
		releases = data.get("releases");
	if (!prs || !issues || !commits || !releases) throw new Error("fixture");
	prs.items = mapFactoryEvents("prs", [
		{
			node_id: "open-old",
			state: "open",
			created_at: "2020-01-01T00:00:00Z",
			base: { ref: "main" },
			draft: true,
			mergeable: true,
			reviewDecision: "APPROVED",
		},
		{
			node_id: "merged-other",
			state: "closed",
			created_at: until,
			merged_at: until,
			closed_at: until,
			user: { login: "person" },
			merged_by: { login: "nocoo" },
			base: { ref: "main" },
		},
	]);
	for (const pr of prs.items) pr.checks = { state: "SUCCESS" };
	issues.items = mapFactoryEvents("issues", [
		...[["dependencies"], ["security"], ["bug"]].map((labels, index) => ({
			node_id: `I${index}`,
			created_at: "2020-01-01T00:00:00Z",
			state: "open",
			closed_by: { login: "nocoo" },
			state_reason: "completed",
			labels: labels.map((name) => ({ name })),
		})),
		{ node_id: "closed", state: "closed", created_at: until, closed_at: until },
	]);
	commits.items = mapFactoryEvents("commits", [
		{
			sha: "same",
			commit: { committer: { date: until }, message: "subject\nbody" },
			author: { login: "nocoo" },
		},
	]);
	releases.items = mapFactoryEvents("releases", [
		{ id: 1, tag_name: "v1", published_at: until },
		{ id: 2, tag_name: "draft", published_at: until, draft: true },
	]);
	const tag = releases.items[0];
	if (!tag) throw new Error("fixture");
	const extra: import("./activity-collect").ActivitySupplement = {
		phase: "done",
		after: null,
		tagAfter: null,
		pending: [],
		deployNext: null,
		pages: 1,
		commits: [
			{
				sha: "same",
				author: null,
				message: "same",
				at: until,
				url: "",
				branch: "feature",
				is_default_branch: false,
			},
			{
				sha: "different",
				author: null,
				message: "new",
				at: until,
				url: "",
				branch: "feature",
				is_default_branch: false,
			},
		],
		tags: [
			{ ...tag, id: "tag1", state: "tag", tag_name: "v1" },
			{ ...tag, id: "tag2", state: "tag", tag_name: "v2" },
		],
		last_success_at: "2020-01-01T00:00:00Z",
		coverage: {
			other_commits: { status: "complete", truncated: false, reason: null },
			tags: { status: "complete", truncated: false, reason: null },
			deploy: { status: "complete", truncated: false, reason: null },
		},
	};
	const out = activityRepo(
		repo,
		data,
		{ since: "2026-10-21T20:00:00.000Z", until, gap: false, first: false },
		extra,
		{
			features: { dependabot: { status: "available" }, code_scanning: { status: "unavailable" } },
			dependabot_open: 0,
			code_scanning_open: 12,
		},
	);
	expect(out.snapshot.open_prs).toHaveLength(1);
	expect(out.snapshot.open_prs?.[0]).toMatchObject({
		id: "open-old",
		draft: true,
		mergeable: true,
		checks: { state: "SUCCESS" },
		review: "APPROVED",
	});
	expect(out.snapshot.open_issues?.dependency).toHaveLength(1);
	expect(out.snapshot.open_issues?.security).toHaveLength(1);
	expect(out.snapshot.open_issues?.other).toHaveLength(1);
	expect(out.snapshot).toMatchObject({ dependabot: 0, code_scanning: null });
	expect(out.commits).toMatchObject({ default: 1, other: 1 });
	expect(out.releases).toHaveLength(2);
	expect(activityTotals([out])).toMatchObject({
		releases: 1,
		dependency_prs: 0,
		other_prs: 1,
		issues_opened: 1,
		issues_closed: 1,
	});
});
it("R4 missing workflow fields and pending sources carry coverage instead of pretending zero", () => {
	const repo = mapFactoryRepo(rawRepo);
	const event = {
		id: "legacy",
		title: "old",
		url: "",
		at: until,
		createdAt: until,
		closedAt: null,
		mergedAt: null,
		author: null,
		state: "completed",
	};
	const resource = {
		runId: "r2",
		items: [event],
		next: null,
		ranges: [],
		coverage: { ...repo.coverage.actions, status: "complete" as const },
	};
	const out = activityRepo(
		repo,
		new Map<string, FactoryStreamData>([
			["actions", resource],
			["prs", { ...resource, coverage: { ...resource.coverage, status: "pending" } }],
			[
				"issues",
				{
					...resource,
					coverage: { ...resource.coverage, status: "partial", reason: "pagination incomplete" },
				},
			],
		]),
		{ since: "2026-10-21T20:00:00.000Z", until, gap: false, first: false },
		null,
		null,
	);
	expect(out.coverage.actions).toMatchObject({ status: "unavailable", truncated: true });
	expect(out.prs.opened).toBeNull();
	expect(out.coverage.issues).toMatchObject({ status: "partial", reason: "pagination incomplete" });
});
it("R4 workflow classification separates PR refs, unknown branches and non-default red runs", async () => {
	const { workflowRun, requireActivityWindow, duringActivity, activityPr } = await import(
		"./activity"
	);
	const events = mapFactoryEvents("actions", [
		{
			id: 1,
			name: "CI",
			head_branch: "main",
			event: "pull_request",
			created_at: until,
			status: "in_progress",
			conclusion: null,
		},
		{
			id: 2,
			name: "CI",
			head_branch: "main",
			created_at: until,
			status: "completed",
			updated_at: until,
			run_started_at: "2026-10-23T00:00:00Z",
		},
		{ id: 3, name: "Deploy", head_branch: null, created_at: until },
	]);
	const first = events[0],
		second = events[1],
		third = events[2];
	if (!first || !second || !third) throw new Error("fixture");
	expect(workflowRun(first, "main")).toMatchObject({ is_default_branch: false, duration_s: null });
	expect(workflowRun(second, "main")).toMatchObject({ is_default_branch: true, duration_s: null });
	expect(workflowRun(third, "main")?.is_default_branch).toBeNull();
	expect(workflowRun(first, null)?.is_default_branch).toBeNull();
	expect(() => requireActivityWindow(run())).toThrow("Activity window missing");
	expect(duringActivity(null, { since: until, until, gap: false, first: false })).toBe(false);
	expect(activityPr({ ...first, author: null })).toMatchObject({ bot: false, dependency: false });
	const current = run();
	current.trigger = "weekly";
	expect(isActivityRun(current)).toBe(false);
	current.trigger = "manual";
	current.selection = { scope: "filter", repo: "nocoo/app" };
	expect(isActivityRun(current)).toBe(false);
	current.mode = "catalog";
	expect(isActivityRun(current)).toBe(false);
});
it("R4 an unattributed failed workflow cannot prove zero red default-branch workflows", () => {
	const repo = mapFactoryRepo(rawRepo);
	const event = mapFactoryEvents("actions", [
		{
			id: 4,
			name: "CI",
			created_at: until,
			status: "completed",
			conclusion: "failure",
			head_branch: null,
			event: "push",
		},
	]);
	const data = new Map<string, FactoryStreamData>();
	for (const stream of FACTORY_STREAMS)
		data.set(stream, {
			runId: "r2",
			items: stream === "actions" ? event : [],
			next: null,
			ranges: [],
			coverage: { ...repo.coverage[stream], status: "complete" },
		});
	const out = activityRepo(
		repo,
		data,
		{ since: "2026-10-21T20:00:00.000Z", until, gap: false, first: false },
		null,
		null,
	);
	expect(activityTotals([out]).red_default_branch).toBeNull();
	expect(out.coverage.default_branch).toMatchObject({ status: "partial" });
});
it("R4 current deployment state reuses complete actions while preserving nullable timestamps and pending CI", () => {
	const repo = mapFactoryRepo(rawRepo);
	const data = new Map<string, FactoryStreamData>();
	for (const stream of FACTORY_STREAMS)
		data.set(stream, {
			runId: "r2",
			items: [],
			next: null,
			ranges: [],
			coverage: { ...repo.coverage[stream], status: "complete" },
		});
	const actions = data.get("actions"),
		prs = data.get("prs"),
		issues = data.get("issues");
	if (!actions || !prs || !issues) throw new Error("fixture");
	actions.items = mapFactoryEvents("actions", [
		{
			id: 1,
			name: "Deploy",
			path: ".github/workflows/deploy.yml",
			head_branch: "main",
			event: "push",
			created_at: "2026-10-20T00:00:00Z",
			updated_at: "2026-10-20T00:01:00Z",
			conclusion: "success",
			status: "completed",
		},
		{
			id: 2,
			name: "Release",
			head_branch: "main",
			event: "push",
			created_at: "2026-10-21T00:00:00Z",
			conclusion: "success",
			status: "completed",
		},
		{
			id: 3,
			name: "CI",
			head_branch: "main",
			event: "push",
			created_at: until,
			conclusion: "success",
			status: "completed",
		},
		{
			id: 4,
			name: "Pending",
			head_branch: "main",
			event: "push",
			created_at: until,
			status: "in_progress",
		},
		{
			id: 5,
			name: "Unknown context pending",
			head_branch: null,
			event: "push",
			created_at: until,
			status: "queued",
		},
	]);
	prs.items = mapFactoryEvents("prs", [
		{
			id: 1,
			node_id: "old-unenriched",
			state: "open",
			created_at: "2020-01-01T00:00:00Z",
			base: { ref: "main" },
		},
		{
			id: 2,
			node_id: "merged-unenriched",
			state: "closed",
			created_at: until,
			merged_at: until,
			base: { ref: "main" },
		},
	]);
	issues.items = mapFactoryEvents("issues", [
		{
			id: 1,
			node_id: "closed-with-actor",
			state: "closed",
			created_at: until,
			closed_at: until,
			closed_by: { login: "nocoo" },
			state_reason: null,
		},
	]);
	const out = activityRepo(
		repo,
		data,
		{ since: "2026-10-21T20:00:00.000Z", until, gap: false, first: false },
		null,
		null,
	);
	expect(out.deploy.last_success_at).toBe("2026-10-21T00:00:00Z");
	expect(out.coverage.prs_fields).toMatchObject({ status: "partial" });
	expect(out.coverage.issue_fields).toMatchObject({ status: "partial" });
	expect(out.coverage.default_branch).toMatchObject({ status: "complete" });
	expect(activityTotals([out]).red_default_branch).toEqual([]);
});
it("R4 missing mergeability checks and review remain explicit partial PR field evidence", () => {
	const repo = mapFactoryRepo(rawRepo);
	const base = {
		runId: "r2",
		next: null,
		ranges: [],
		coverage: { ...repo.coverage.prs, status: "complete" as const },
	};
	for (const row of [
		{ node_id: "base-missing", state: "open", created_at: until },
		{
			node_id: "checks-missing",
			state: "open",
			created_at: until,
			base: { ref: "main" },
			reviewDecision: "APPROVED",
		},
		{ node_id: "review-missing", state: "open", created_at: until, base: { ref: "main" } },
	]) {
		const items = mapFactoryEvents("prs", [row]);
		if (row.node_id === "review-missing" && items[0]) items[0].checks = { state: "SUCCESS" };
		const out = activityRepo(
			repo,
			new Map([["prs", { ...base, items }]]),
			{ since: "2026-10-21T20:00:00.000Z", until, gap: false, first: false },
			null,
			null,
		);
		expect(out.coverage.prs_fields?.status).toBe("partial");
		expect(out.snapshot.open_prs).toHaveLength(1);
	}
});
