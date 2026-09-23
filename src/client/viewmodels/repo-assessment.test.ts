// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoAssessment } from "../../lib/repo-assessment";
import {
	assessmentPending,
	assessmentStale,
	loadRepoAssessment,
	prioritizedActions,
} from "./repo-assessment";
import { setActiveAccountId } from "./session";

const assessment: RepoAssessment = {
	account_id: "a",
	repo: "octocat/hello-world",
	status: "complete",
	sourceVersion: "v2",
	sourceAt: "2026-09-24T10:00:00.000Z",
	reportVersion: "v2",
	reportAt: "2026-09-24T10:02:00.000Z",
	judgment: null,
	report: {
		schemaVersion: 1,
		overall: "healthy",
		summary: "Steady delivery.",
		security: { status: "unknown", summary: "Optional source unavailable.", evidenceIds: [] },
		pullRequests: { status: "healthy", summary: "Reviewed.", evidenceIds: [] },
		issues: { status: "healthy", summary: "Triaged.", evidenceIds: [] },
		delivery: { status: "healthy", summary: "Steady.", evidenceIds: [], trend: "steady" },
		actions: [],
		limitations: [],
	},
	error: null,
};

function mockFetch(reply: () => Promise<Response>) {
	const urls: string[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		urls.push(String(input));
		expect(init?.method).toBeUndefined();
		if (String(input) === "/api/accounts") {
			return Response.json({ accounts: [{ id: "a", login: "octocat", is_active: true }] });
		}
		return reply();
	});
	return urls;
}

describe("repository assessment", () => {
	afterEach(() => {
		setActiveAccountId(null);
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("loads the saved report through GET without starting an AI run", async () => {
		const urls = mockFetch(async () => Response.json(assessment));
		expect(await loadRepoAssessment("octocat", "hello-world")).toEqual(assessment);
		expect(urls).toEqual(["/api/accounts", "/api/repos/octocat/hello-world/assessment"]);
	});

	it("rejects illegal repository paths before loading the account", async () => {
		const urls = mockFetch(async () => Response.json(assessment));
		expect(await loadRepoAssessment("..", "hello-world")).toEqual({ missing: true });
		expect(await loadRepoAssessment("octocat", "bad/name")).toEqual({ missing: true });
		expect(urls).toEqual([]);
	});

	it("treats absent reports and unsupported endpoints as a quiet missing state", async () => {
		for (const [status, code] of [
			[409, "snapshot_missing"],
			[404, "not_found"],
		] as const) {
			mockFetch(async () => Response.json({ error: { code, message: "No report" } }, { status }));
			expect(await loadRepoAssessment("octocat", "hello-world")).toEqual({ missing: true });
		}
	});

	it("preserves real failures for inline retry feedback", async () => {
		mockFetch(async () =>
			Response.json({ error: { code: "db_error", message: "Unavailable" } }, { status: 503 }),
		);
		await expect(loadRepoAssessment("octocat", "hello-world")).rejects.toMatchObject({
			code: "db_error",
		});
		mockFetch(async () => {
			throw new TypeError("Connection failed");
		});
		await expect(loadRepoAssessment("octocat", "hello-world")).rejects.toThrow("Connection failed");
	});

	it("resynchronizes instead of displaying a different account's report", async () => {
		const urls = mockFetch(async () => Response.json({ ...assessment, account_id: "other" }));
		expect(await loadRepoAssessment("octocat", "hello-world")).toEqual({ missing: true });
		expect(urls.filter((url) => url === "/api/accounts")).toHaveLength(2);
	});

	it("discards replies and errors after the account changes, including an A-B-A race", async () => {
		for (const fail of [false, true]) {
			mockFetch(async () => {
				setActiveAccountId("b");
				setActiveAccountId("a");
				if (fail) throw new Error("Outdated request failed");
				return Response.json(assessment);
			});
			expect(await loadRepoAssessment("octocat", "hello-world")).toEqual({ missing: true });
		}
	});

	it("polls only running assessments and marks retained reports as stale", () => {
		for (const status of ["unconfigured", "missing", "complete", "failed"] as const) {
			expect(assessmentPending(status)).toBe(false);
		}
		expect(assessmentPending("judgment")).toBe(true);
		expect(assessmentPending("summary")).toBe(true);
		expect(assessmentStale(assessment)).toBe(false);
		expect(assessmentStale({ ...assessment, report: null })).toBe(false);
		expect(assessmentStale({ ...assessment, reportVersion: "v1" })).toBe(true);
		expect(assessmentStale({ ...assessment, status: "failed" })).toBe(true);
	});

	it("orders recommendations by priority without mutating the saved report", () => {
		const actions = [
			{ priority: "later", title: "Document", reason: "Useful", evidenceIds: [] },
			{ priority: "now", title: "Patch", reason: "Critical", evidenceIds: ["security:1"] },
			{ priority: "next", title: "Review", reason: "External change", evidenceIds: ["pr:2"] },
		] as const;
		const mutable = actions.map((action) => ({ ...action, evidenceIds: [...action.evidenceIds] }));
		expect(prioritizedActions(mutable).map((action) => action.title)).toEqual([
			"Patch",
			"Review",
			"Document",
		]);
		expect(mutable.map((action) => action.title)).toEqual(["Document", "Patch", "Review"]);
	});
});
