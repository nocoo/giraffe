import { expect, it, vi } from "vitest";
import { ApiError, GiraffeClient } from "./client.ts";
import type { Resource } from "./contracts.ts";
import { expiredResources, pruneRemote } from "./retention.ts";

const time = "2026-10-02T12:00:00.000Z";
const row = (id: string, payload = {}): Resource => ({
	id,
	account_id: "test",
	repository: "owner/repo",
	type: "github-analysis",
	status: "completed",
	source_version: "v1",
	payload,
	revision: 1,
	created_at: time,
	updated_at: time,
});
const report = {
	schemaVersion: 1,
	scope: "repo",
	repository: "owner/repo",
	domain: "ci",
	verdict: "unknown",
	summary: "No data",
	findings: [],
	actions: [],
	limitations: [],
	sourceVersion: "v1",
	observedAt: time,
	generatedAt: time,
	sources: [],
	evidence: [],
	omitted: 0,
	judgment: {
		model: "jev",
		choice: "unknown",
		confidence: 1,
		probabilities: { unknown: 1, urgent: 0, review: 0, routine: 0 },
	},
	producer: {
		orchestrator: "planner",
		executor: "worker",
		decision: "jev",
		conversationId: 1,
		jobId: "job",
	},
};
it("keeps two reports per scope/domain and active or latest failed jobs", () => {
	const reports = [
		row("1", report),
		row("2", report),
		row("3", report),
		row("invalid"),
		{ ...row("other", report), type: "other" },
		row("global", { ...report, scope: "global", repository: null }),
	];
	const jobs = Array.from({ length: 30 }, (_, index) => row(String(index).padStart(2, "0")));
	jobs.push(
		{ ...row("failed"), status: "failed" },
		{ ...row("active"), status: "running" },
		{ ...row("other-job"), type: "other" },
	);
	expect(expiredResources(reports, jobs).reports.map((item) => item.id)).toEqual(["1"]);
	expect(
		expiredResources(reports, jobs).jobs.some(
			(item) => item.id === "failed" || item.id === "active" || item.id === "other-job",
		),
	).toBe(false);
	expect(expiredResources([], jobs).jobs).toHaveLength(11);
});
it("uses optimistic deletes and tolerates changed or removed records", async () => {
	const client = new GiraffeClient({
		baseUrl: "https://example.test",
		token: "test",
		account_id: "test",
		expires_at: "2099-01-01T00:00:00Z",
		scopes: [],
	});
	vi.spyOn(client, "list").mockImplementation(async (collection) =>
		collection === "reports"
			? Array.from({ length: 5 }, (_, index) => row(String(index), report))
			: [],
	);
	const remove = vi
		.spyOn(client, "remove")
		.mockResolvedValue()
		.mockRejectedValueOnce(new ApiError(409, "revision_conflict"))
		.mockRejectedValueOnce(new ApiError(404, "not_found"));
	await pruneRemote(client);
	expect(remove).toHaveBeenCalledTimes(3);
	remove.mockRejectedValueOnce(new ApiError(500, "db_error"));
	await expect(pruneRemote(client)).rejects.toThrow("db_error");
	vi.restoreAllMocks();
});
