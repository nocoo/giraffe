import { expect, it } from "vitest";
import type { ActivityPr, ActivityRepo, ActivityRun } from "../../lib/activity-types";
import { activityReadContentVersion, readActivityTotals } from "./activity-totals";

function repository(name: string): ActivityRepo {
	const repo: ActivityRepo = {
		repo: name,
		ci_runs: [],
		prs: { opened: [], merged: [], closed: [] },
		issues: { opened: [], closed: [] },
		releases: [],
		commits: { default: null, other: null, items: null },
		deploy: { last_success_at: null, runs: null },
		snapshot: { open_prs: null, open_issues: null, dependabot: null, code_scanning: null },
		coverage: {},
	};
	repo.ci_runs = [];
	repo.prs.merged = [];
	repo.issues.opened = [];
	repo.issues.closed = [];
	repo.releases = [];
	for (const stream of ["actions", "prs", "issues", "releases", "default_branch"])
		repo.coverage[stream] = { status: "complete", truncated: false, reason: null };
	return repo;
}

it("keeps missing saved lists unknown and ignores non-red or non-default workflow evidence", () => {
	const repo = repository("owner/app");
	repo.releases = null;
	repo.prs.merged = null;
	repo.issues.opened = null;
	repo.issues.closed = null;
	repo.ci_runs = [
		{ id: 1, conclusion: null, is_default_branch: null },
		{ id: 2, conclusion: null, is_default_branch: true },
		{ id: 3, conclusion: "failure", is_default_branch: false },
	] as ActivityRun[];
	expect(readActivityTotals([repo])).toMatchObject({
		totals: {
			merged_prs: null,
			issues_opened: null,
			issues_closed: null,
			releases: null,
			red_default_branch: [],
		},
	});
});

it("sums independently available metrics despite unrelated partial run coverage", () => {
	const healthy = repository("owner/healthy");
	const partial = repository("owner/partial");
	partial.coverage.run = { status: "partial", truncated: false, reason: "alerts unavailable" };
	partial.coverage.prs = { status: "partial", truncated: true, reason: "bounded page" };
	partial.coverage.default_branch = { status: "unavailable", truncated: false, reason: null };
	healthy.coverage.releases = { status: "unavailable", truncated: false, reason: null };
	partial.coverage.releases = { status: "unavailable", truncated: false, reason: null };
	const before = structuredClone([healthy, partial]);
	const result = readActivityTotals([healthy, partial]);
	expect(result.totals).toEqual({
		ci_runs: 0,
		merged_prs: 0,
		dependency_prs: 0,
		other_prs: 0,
		issues_opened: 0,
		issues_closed: 0,
		releases: null,
		red_default_branch: [],
	});
	expect(result.totals_partial).toBe(true);
	expect(result.totals_coverage.missing).toEqual([
		{ repo: "owner/healthy", metrics: ["releases"], reason: "unavailable" },
		{
			repo: "owner/partial",
			metrics: ["merged_prs", "dependency_prs", "other_prs"],
			reason: "partial",
		},
		{ repo: "owner/partial", metrics: ["releases", "red_default_branch"], reason: "unavailable" },
	]);
	expect([healthy, partial]).toEqual(before);
	expect(readActivityTotals([healthy, partial])).toEqual(result);
});

it("reports omitted members without discarding available totals or inventing zeroes", () => {
	const repo = repository("owner/kept");
	expect(readActivityTotals([repo], ["owner/kept", "owner/omitted"])).toMatchObject({
		totals: { ci_runs: 0 },
		totals_partial: true,
		totals_coverage: { missing: [{ repo: "owner/omitted", reason: "omitted" }] },
	});
	expect(Object.values(readActivityTotals([], ["owner/omitted"]).totals)).toEqual(
		Array(8).fill(null),
	);
	expect(readActivityTotals([])).toMatchObject({
		totals: { ci_runs: 0, red_default_branch: [] },
		totals_partial: false,
		totals_coverage: { missing: [] },
	});
	expect(readActivityTotals([repo], undefined, true)).toMatchObject({
		totals_partial: true,
		totals_coverage: { missing: [{ repo: null, reason: "omitted" }] },
	});
});

it("marks missing lists or unclassified red workflows as missing evidence", () => {
	const repo = repository("owner/app");
	repo.ci_runs = null;
	delete repo.coverage.prs;
	expect(readActivityTotals([repo])).toMatchObject({
		totals: { ci_runs: null, merged_prs: null, red_default_branch: null },
		totals_coverage: {
			missing: [{ repo: "owner/app", reason: "missing_evidence" }],
		},
	});
});

it("adds nonzero counts and red workflows only from proven repository metrics", () => {
	const first = repository("owner/first");
	const second = repository("owner/second");
	first.prs.merged = [{ dependency: true }, { dependency: false }] as ActivityPr[];
	second.prs.merged = first.prs.merged;
	second.coverage.prs = { status: "partial", truncated: true, reason: "cut" };
	first.ci_runs = [{ id: 1, conclusion: "failure", is_default_branch: true }] as ActivityRun[];
	second.ci_runs = first.ci_runs;
	const result = readActivityTotals([first, second]);
	expect(result.totals).toMatchObject({
		ci_runs: 2,
		merged_prs: 2,
		dependency_prs: 1,
		other_prs: 1,
		red_default_branch: [
			{ repo: "owner/first", id: 1 },
			{ repo: "owner/second", id: 1 },
		],
	});
	if (second.ci_runs?.[0]) second.ci_runs[0] = { ...second.ci_runs[0], is_default_branch: null };
	expect(readActivityTotals([second])).toMatchObject({
		totals: { ci_runs: 1, red_default_branch: null },
		totals_coverage: {
			missing: expect.arrayContaining([
				{ repo: second.repo, metrics: ["red_default_branch"], reason: "missing_evidence" },
			]),
		},
	});
});

it("binds activity content versions to the frozen publication and read derivation", async () => {
	const version = await activityReadContentVersion("saved-hash");
	expect(version).toMatch(/^sha256:[a-f0-9]{64}$/);
	expect(version).not.toBe("saved-hash");
	expect(await activityReadContentVersion("saved-hash")).toBe(version);
	expect(await activityReadContentVersion("another-hash")).not.toBe(version);
});
