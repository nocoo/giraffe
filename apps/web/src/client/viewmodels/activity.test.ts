// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityFixture,
	activityPr,
	activityRepo,
	activityRun,
} from "../../../../../tests/e2e/activity-fixtures";
import { apiGet } from "../lib/api";
import { ApiError } from "../lib/errors";
import {
	activityCount,
	activityObservedCount,
	activitySectionState,
	activitySections,
	activitySummary,
	isActivityFailure,
	loadActivity,
} from "./activity";
import { setActiveAccountId } from "./session";

vi.mock("../lib/api", () => ({ apiGet: vi.fn() }));

beforeEach(() => {
	setActiveAccountId("ui-account");
	vi.mocked(apiGet).mockImplementation(async (resource) =>
		resource === "accounts"
			? { accounts: [{ id: "ui-account", is_active: true }] }
			: activityFixture(),
	);
});

afterEach(() => {
	vi.clearAllMocks();
	setActiveAccountId(null);
});

describe("current-run activity presentation", () => {
	it("keeps unavailable, truncated and truly empty sections distinct", () => {
		expect(activitySectionState(null, false)).toBe("unknown");
		expect(activitySectionState(null, true)).toBe("unknown");
		expect(activitySectionState(0, false)).toBe("empty");
		expect(activitySectionState(0, true)).toBe("partial");
		expect(activitySectionState(2, true)).toBe("partial");
		expect(activitySectionState(2, false)).toBe("ready");
	});

	it("flags failed CI and deployment outcomes without calling pending or cancellation red", () => {
		for (const conclusion of ["failure", "timed_out", "action_required", "startup_failure"]) {
			expect(isActivityFailure(conclusion)).toBe(true);
		}
		for (const conclusion of [null, "success", "cancelled", "skipped", "neutral", "stale"]) {
			expect(isActivityFailure(conclusion)).toBe(false);
		}
	});

	it("reads the latest active-account publication with an encoded optional repository", async () => {
		expect(await loadActivity()).toEqual(activityFixture());
		expect(apiGet).toHaveBeenCalledWith("activity?run=latest");
		await loadActivity("octocat/hello-world");
		expect(apiGet).toHaveBeenCalledWith("activity?run=latest&repository=octocat%2Fhello-world");
	});

	it("keeps missing publications distinct from an observed empty window", async () => {
		vi.mocked(apiGet).mockImplementation(async (resource) => {
			if (resource === "accounts") return { accounts: [{ id: "ui-account", is_active: true }] };
			throw new ApiError(409, "activity_unpublished", "No published quick run");
		});
		await expect(loadActivity()).rejects.toMatchObject({ code: "activity_unpublished" });
	});

	it("discards late activity from another account", async () => {
		vi.mocked(apiGet).mockImplementation(async (resource) => {
			if (resource === "accounts") return { accounts: [{ id: "ui-account", is_active: true }] };
			setActiveAccountId("other");
			return activityFixture();
		});
		expect(await loadActivity()).toEqual({ missing: true });
	});

	it("groups PR and Issue lifecycle events and links every row to its repository", () => {
		const snap = activityFixture();
		const repo = snap.repos[0];
		if (!repo) throw new Error("Missing fixture repository");
		const pr = activityPr();
		const issue = {
			...activityPr("42"),
			title: "Track current-run gaps",
			labels: ["bug"],
			closed_by: "octocat",
			state_reason: "completed",
		};
		repo.prs = { opened: [pr], merged: [pr], closed: [pr] };
		repo.issues = { opened: [issue], closed: [issue] };
		repo.releases = [{ ...pr, id: "release-1", title: "v0.19.0" }];
		const sections = activitySections(snap);
		expect(sections.map((section) => section.key)).toEqual([
			"merged",
			"opened",
			"closed",
			"releases",
			"ci",
			"deploy",
		]);
		expect(sections.map((section) => section.rows.length)).toEqual([1, 2, 2, 1, 0, 0]);
		for (const section of sections) {
			for (const row of section.rows) expect(row.repo).toBe("octocat/hello-world");
		}
		expect(sections[1]?.rows.map((row) => row.kind)).toEqual(["PR", "Issue"]);
	});

	it("shows only red default-branch CI and actual deployment failures", () => {
		const snap = activityFixture();
		const repo = snap.repos[0];
		if (!repo) throw new Error("Missing fixture repository");
		repo.ci_runs = [
			activityRun(),
			{ ...activityRun(102), is_default_branch: false },
			{ ...activityRun(103), is_default_branch: null },
			{ ...activityRun(104), conclusion: "success" },
		];
		repo.deploy.runs = [
			...repo.ci_runs,
			{ ...activityRun(105), conclusion: null, status: "in_progress" },
		];
		const sections = activitySections(snap);
		expect(sections.find((section) => section.key === "ci")?.rows.map((row) => row.id)).toEqual([
			"octocat/hello-world:run:101",
		]);
		expect(sections.find((section) => section.key === "deploy")?.rows).toHaveLength(3);
	});

	it("retains available rows while identifying missing repositories rather than reporting zero", () => {
		const snap = activityFixture();
		const missing = activityRepo();
		missing.repo = "octocat/basalt";
		missing.prs.merged = null;
		const available = snap.repos[0];
		if (!available) throw new Error("Missing fixture repository");
		available.prs.merged = [activityPr()];
		snap.repos.push(missing);
		const merged = activitySections(snap)[0];
		expect(merged?.state).toBe("unknown");
		expect(merged?.rows).toHaveLength(1);
		expect(merged?.missingRepos).toEqual(["octocat/basalt"]);
	});

	it("never presents a capacity-truncated empty list as an observed empty window", () => {
		const snap = activityFixture();
		snap.truncated = true;
		expect(activitySections(snap).every((section) => section.state === "partial")).toBe(true);
		expect(activitySections(activityFixture()).every((section) => section.state === "empty")).toBe(
			true,
		);
	});

	it("honors per-list coverage even when an empty array was retained", () => {
		const snap = activityFixture();
		const repo = snap.repos[0];
		if (!repo) throw new Error("Missing fixture repository");
		repo.coverage["prs.merged"] = { status: "partial", reason: "page budget", truncated: true };
		expect(activitySections(snap)[0]?.state).toBe("partial");
		expect(activitySections(snap).find((section) => section.key === "ci")?.state).toBe("empty");
		repo.coverage.actions = { status: "unavailable", reason: "unknown", truncated: false };
		expect(activitySections(snap).find((section) => section.key === "ci")?.state).toBe("unknown");
		delete repo.coverage.releases;
		expect(activitySections(snap).find((section) => section.key === "releases")?.state).toBe(
			"unknown",
		);
	});

	it("does not turn missing account repository coverage into an empty window", () => {
		const snap = activityFixture();
		snap.repos = [];
		snap.coverage.repos = { status: "unavailable", reason: "unknown", truncated: false };
		expect(activitySections(snap).every((section) => section.state === "unknown")).toBe(true);
		expect(activitySummary(snap).merged).toBe("未知");
	});

	it("does not call red CI empty when a failed run has unknown default-branch membership", () => {
		const snap = activityFixture();
		const repo = snap.repos[0];
		if (!repo) throw new Error("Missing fixture repository");
		repo.ci_runs = [{ ...activityRun(), is_default_branch: null, head_branch: null }];
		repo.deploy.runs = repo.ci_runs;
		const ci = activitySections(snap).find((section) => section.key === "ci");
		expect(ci?.rows).toEqual([]);
		expect(ci?.state).toBe("unknown");
		expect(ci?.missingRepos).toEqual([repo.repo]);
		expect(
			activitySections(snap).find((section) => section.key === "deploy")?.rows[0]?.kind,
		).toContain("未知分支");
	});

	it("marks partial counts as lower bounds while preserving unknown independently", () => {
		expect(activityCount(null)).toBe("未知");
		expect(activityCount(0)).toBe("0");
		expect(activityCount(1500)).toBe("1,500");
		expect(activityObservedCount(0, undefined)).toBe("未知");
		expect(
			activityObservedCount(null, { status: "complete", truncated: false, reason: null }),
		).toBe("未知");
		expect(activityObservedCount(0, { status: "partial", truncated: true, reason: "budget" })).toBe(
			"≥ 0",
		);
		expect(activityObservedCount(3, { status: "complete", truncated: false, reason: null })).toBe(
			"3",
		);
		expect(
			activityObservedCount(3, { status: "unavailable", truncated: false, reason: "unknown" }),
		).toBe("未知");
		const snap = activityFixture();
		expect(activitySummary(snap)).toEqual({
			merged: "0",
			dependency: "0",
			other: "0",
			opened: "0",
			closed: "0",
			releases: "0",
		});
		snap.truncated = true;
		expect(activitySummary(snap).merged).toBe("≥ 0");
		const repo = snap.repos[0];
		if (!repo) throw new Error("Missing fixture repository");
		repo.coverage["issues.opened"] = { status: "unavailable", truncated: false, reason: "unknown" };
		expect(activitySummary(snap).opened).toBe("未知");
	});
});
