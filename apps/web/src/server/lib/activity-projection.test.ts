import { describe, expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import type { ActivityWindow } from "../../lib/activity-types";
import type { FactoryEvent, FactoryStreamData } from "../../lib/factory-types";
import { type ActivityInputs, projectActivityRepo } from "./activity-projection";
import { readActivityTotals } from "./activity-totals";

const window: ActivityWindow = {
	since: "2026-10-28T00:00:00.000Z",
	until: "2026-10-28T23:59:59.999Z",
	first: true,
	gap: true,
};
const at = "2026-10-28T12:00:00.000Z";
function item(overrides: Partial<FactoryEvent> = {}): FactoryEvent {
	return {
		id: "1",
		title: "Lifecycle",
		url: "https://github.com/owner/app/issues/1",
		at,
		createdAt: at,
		updatedAt: at,
		closedAt: null,
		mergedAt: null,
		author: "collaborator",
		state: "open",
		...overrides,
	};
}
function fixture() {
	const repo = factoryFixture().repos[0];
	if (!repo) throw new Error("fixture repository missing");
	repo.metadataAt = at;
	repo.observation = { version: "current", window, refreshedAt: at, source: "run" };
	const inputs: ActivityInputs = new Map();
	const set = (
		stream: "issues" | "prs" | "actions" | "releases",
		items: FactoryEvent[] = [],
		changes: Partial<FactoryStreamData> = {},
	) => {
		const coverage = {
			status: "complete" as const,
			pages: 1,
			fetchedAt: at,
			source: "github",
			reason: null,
			observed: items.length,
		};
		repo.coverage[stream] = coverage;
		const saved = {
			data: { runId: "current", items, next: null, ranges: [window], coverage, ...changes },
			raw: new Map<string, Record<string, unknown>>(),
			snapshot: undefined as Record<string, unknown> | undefined,
		};
		inputs.set(stream, saved);
		return saved;
	};
	for (const stream of ["issues", "prs", "actions", "releases"] as const) set(stream);
	const read = () => projectActivityRepo("owner/app", repo, inputs, window);
	return { repo, inputs, set, read };
}

describe("canonical activity source evidence", () => {
	it("keeps missing streams and missing published repositories unavailable", () => {
		const { repo, inputs } = fixture();
		inputs.clear();
		for (const source of [repo, undefined]) {
			const result = projectActivityRepo("owner/app", source, inputs, window);
			expect(result.issues).toEqual({ opened: null, closed: null });
			expect(result.prs.merged).toBeNull();
			expect(result.ci_runs).toBeNull();
			expect(result.releases).toBeNull();
			expect(result.coverage.issues).toMatchObject({
				status: "unavailable",
				reason: "source_missing",
			});
		}
	});
	it("rejects resources that do not match published stream versions", () => {
		const { set, read } = fixture();
		set("issues", [item()], { runId: "unpublished" });
		expect(read().issues.opened).toBeNull();
		expect(read().coverage.issues).toMatchObject({
			status: "unavailable",
			reason: "source_version_mismatch",
			source: { runId: "unpublished", fetchedAt: at, window },
		});
	});
	it("preserves mixed stream versions, timestamps and original windows without upgrading their coverage", () => {
		const { repo, set, read } = fixture();
		const oldWindow = { since: "2026-10-27T00:00:00.000Z", until: "2026-10-28T12:00:00.000Z" };
		const saved = set("issues", [item()], { runId: "previous", ranges: [oldWindow] });
		repo.coverage.issues.observation = {
			version: "previous",
			window: oldWindow,
			refreshedAt: "old-fetch",
			source: "run",
			head: null,
		};
		saved.data.coverage.fetchedAt = "old-fetch";
		const result = read();
		expect(result.issues.opened).toHaveLength(1);
		expect(result.coverage.issues).toMatchObject({
			status: "partial",
			source: {
				runId: "previous",
				fetchedAt: "old-fetch",
				window: oldWindow,
				completeWindows: [oldWindow],
			},
		});
		expect(readActivityTotals([result]).totals.issues_opened).toBeNull();
	});
	it.each([
		{ since: "2026-10-26T00:00:00.000Z", until: "2026-10-27T23:59:59.999Z" },
		{ since: "2026-10-29T00:00:00.000Z", until: "2026-10-29T23:59:59.999Z" },
	])("does not reinterpret disjoint source windows as the current window: %j", (sourceWindow) => {
		const { repo, set, read } = fixture();
		set("issues", [item()], { ranges: [sourceWindow] });
		if (repo.observation) repo.observation.window = sourceWindow;
		expect(read().issues.opened).toBeNull();
		expect(read().coverage.issues?.reason).toBe("outside_activity_window");
	});
	it.each(["pending", "unavailable"] as const)(
		"keeps %s coverage unavailable even when stale items remain",
		(status) => {
			const { set, read } = fixture();
			const saved = set("issues", [item()]);
			saved.data.coverage = { ...saved.data.coverage, status, reason: null };
			expect(read().coverage.issues).toMatchObject({
				status: "unavailable",
				reason: "source_unavailable",
			});
			expect(read().issues.opened).toBeNull();
			saved.data.coverage.reason = "permission_denied";
			expect(read().coverage.issues?.reason).toBe("permission_denied");
		},
	);
	it.each(["partial", "limited"] as const)(
		"returns observed %s lifecycle events while totals remain unknown",
		(status) => {
			const { set, read } = fixture();
			const saved = set("issues", [item()], { ranges: [] });
			saved.data.coverage = { ...saved.data.coverage, status, reason: "incomplete_pagination" };
			const result = read();
			expect(result.issues.opened).toHaveLength(1);
			expect(result.coverage.issues).toMatchObject({
				status: "partial",
				truncated: true,
				reason: "incomplete_pagination",
			});
			expect(readActivityTotals([result]).totals.issues_opened).toBeNull();
		},
	);
	it("includes lifecycle timestamps at both inclusive boundaries and excludes outside events", () => {
		const { set, read } = fixture();
		set("issues", [
			item({ id: "start", at: null, createdAt: window.since }),
			item({ id: "end", createdAt: "2026-10-27T00:00:00Z", at: null, closedAt: window.until }),
			item({ id: "outside", at: null, createdAt: "2026-10-29T00:00:00Z" }),
			item({ id: "unknown", at: null, createdAt: null }),
		]);
		expect(read().issues.opened?.map((row) => row.id)).toEqual(["start"]);
		expect(read().issues.closed?.map((row) => row.id)).toEqual(["end"]);
	});
	it("detects a one-millisecond gap rather than reconciling missing observations to zero", () => {
		const { set, read } = fixture();
		set("issues", [], {
			ranges: [
				{ since: window.since, until: at },
				{ since: "2026-10-28T12:00:00.002Z", until: window.until },
			],
		});
		expect(read().coverage.issues?.status).toBe("partial");
		expect(readActivityTotals([read()]).totals.issues_opened).toBeNull();
	});
	it("accepts adjacent complete ranges regardless of ordering", () => {
		const { set, read } = fixture();
		set("issues", [], {
			ranges: [
				{ since: "2026-10-28T12:00:00.001Z", until: window.until },
				{ since: window.since, until: at },
			],
		});
		expect(read().coverage.issues?.status).toBe("complete");
		expect(readActivityTotals([read()]).totals.issues_opened).toBe(0);
	});
	it("does not let missing labels fabricate negative dependency attribution", () => {
		const { set, read } = fixture();
		set("prs", [item({ state: "merged", mergedAt: at, author: null })]);
		const result = read();
		expect(result.coverage.pr_classification?.status).toBe("partial");
		expect(readActivityTotals([result])).toMatchObject({
			totals: { merged_prs: 1, dependency_prs: null, other_prs: null },
			totals_partial: true,
			totals_coverage: {
				missing: [
					{ repo: "owner/app", reason: "partial", metrics: ["dependency_prs", "other_prs"] },
				],
			},
		});
	});
	it("uses explicit event metadata and proven raw sidecars but ignores mismatched raw revisions", () => {
		const { set, read } = fixture();
		const saved = set("prs", [
			item({
				id: "direct",
				state: "merged",
				mergedAt: at,
				dependency: true,
				bot: true,
				base_ref: "release",
				merged_by: "maintainer",
				labels: ["dependencies"],
			}),
			item({ id: "raw", state: "merged", mergedAt: at }),
			item({ id: "stale", state: "merged", mergedAt: at }),
		]);
		saved.raw.set("raw", {
			updatedAt: at,
			labels: { nodes: [{ name: "dependencies" }] },
			baseRefName: "main",
		});
		saved.raw.set("stale", {
			updatedAt: "2026-10-29T00:00:00Z",
			labels: { nodes: [] },
			baseRefName: "stale",
		});
		const result = read();
		expect(result.prs.merged).toMatchObject([
			{ dependency: true, bot: true, base_ref: "release", merged_by: "maintainer" },
			{ dependency: true, base_ref: "main", merged_by: null },
			{ dependency: false, base_ref: null, merged_by: null },
		]);
		expect(result.coverage.pr_classification?.status).toBe("partial");
	});
	it("recognizes known dependency bots and leaves unknown issue actors null", () => {
		const { set, read } = fixture();
		set("prs", [
			item({ author: "dependabot[bot]", mergedAt: at }),
			item({ id: "renovate", author: "renovate", mergedAt: at }),
		]);
		set("issues", [
			item({
				labels: ["security"],
				closedAt: at,
				closed_by: "maintainer",
				state_reason: "completed",
			}),
			item({ id: "unknown", author: null, labels: [] }),
		]);
		expect(read().prs.merged?.map((row) => row.dependency)).toEqual([true, true]);
		expect(read().coverage.pr_classification?.status).toBe("complete");
		expect(read().issues.closed).toMatchObject([
			{ closed_by: "maintainer", state_reason: "completed" },
		]);
		expect(read().issues.opened?.[1]).toMatchObject({
			author: null,
			closed_by: null,
			state_reason: null,
		});
	});
	it("keeps releases separate from drafts and reports unsupported tags honestly", () => {
		const { set, read } = fixture();
		set("releases", [
			item({ id: "published", state: "published" }),
			item({ id: "draft", state: "draft" }),
		]);
		expect(read().releases?.map((row) => row.id)).toEqual(["published"]);
		expect(read().coverage.tags?.status).toBe("unavailable");
	});
	it("only joins CI sidecars with the matching source timestamp and event identity", () => {
		const { set, read } = fixture();
		const saved = set("actions", [
			item({ id: "7", title: "Deploy", state: "completed", conclusion: "failure" }),
		]);
		saved.snapshot = {
			coverage: { fetchedAt: at },
			runs: [{ id: 7, created_at: at, event: "push", head_branch: "main" }],
		};
		expect(read().ci_runs).toMatchObject([
			{ id: 7, event: "push", head_branch: "main", is_default_branch: true },
		]);
		expect(read().deploy.runs).toHaveLength(1);
		saved.snapshot = { ...saved.snapshot, coverage: { fetchedAt: "different" } };
		expect(read().ci_runs).toMatchObject([
			{ event: null, head_branch: null, is_default_branch: null },
		]);
		expect(readActivityTotals([read()]).totals.red_default_branch).toBeNull();
	});
	it("does not classify default-branch CI with metadata from a different source run", () => {
		const { repo, set, read } = fixture();
		const saved = set("actions", [
			item({ id: "7", title: "CI", state: "completed", conclusion: "failure" }),
		]);
		repo.coverage.actions.observation = {
			version: "earlier",
			window,
			refreshedAt: at,
			source: "run",
			head: null,
		};
		saved.data.runId = "earlier";
		saved.snapshot = {
			coverage: { fetchedAt: at },
			runs: [{ id: 7, created_at: at, head_branch: "main" }],
		};
		expect(read().ci_runs).toMatchObject([{ is_default_branch: null }]);
		expect(read().coverage.actions?.status).toBe("complete");
		expect(read().coverage.default_branch?.status).toBe("unavailable");
	});
	it("preserves embedded workflow fields and reports the last proven successful deployment", () => {
		const { set, read } = fixture();
		const run = {
			id: 7,
			workflow_id: 8,
			workflow_name: "Publish",
			event: "workflow_dispatch",
			head_branch: "main",
			head_sha: "sha",
			status: "completed",
			conclusion: "success",
			run_attempt: 2,
			created_at: at,
			updated_at: "2026-10-28T12:01:00Z",
			run_started_at: at,
			duration_s: 60,
			html_url: "https://github.com/owner/app/actions/runs/7",
			actor: "maintainer",
			path: ".github/workflows/publish.yml",
		};
		set("actions", [
			item({ id: "7", activityRun: run }),
			item({ id: "9", title: "Deploy", conclusion: "success", updatedAt: null }),
			item({ id: "10", title: "Deploy", conclusion: "success", createdAt: null, updatedAt: null }),
		]);
		expect(read().ci_runs?.[0]).toEqual({ ...run, is_default_branch: true });
		expect(read().deploy.last_success_at).toBe(run.updated_at);
		expect(read().deploy.runs).toHaveLength(3);
	});
	it("only partitions observed open items and never calls windowed lists a full repository snapshot", () => {
		const { set, read } = fixture();
		set("issues", [
			item({ id: "security", labels: ["security", "dependencies"] }),
			item({ id: "dependencies", labels: ["dependencies"] }),
			item({ id: "other", labels: [] }),
			item({ id: "closed", labels: [], state: "closed" }),
		]);
		set("prs", [
			item({ id: "open", labels: [] }),
			item({ id: "merged", state: "merged", labels: [] }),
		]);
		expect(read().snapshot.open_issues).toMatchObject({
			security: [{ id: "security" }],
			dependency: [{ id: "dependencies" }],
			other: [{ id: "other" }],
		});
		expect(read().snapshot.open_prs?.map((row) => row.id)).toEqual(["open"]);
		expect(read().coverage["snapshot.open_issues"]).toMatchObject({
			status: "partial",
			reason: "windowed_snapshot",
		});
		expect(read().coverage["snapshot.open_prs"]).toMatchObject({
			status: "partial",
			reason: "windowed_snapshot",
		});
	});
});
