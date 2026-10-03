import type { Resource } from "@nocoo/giraffe-agent/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { apiGet, apiPost, apiWrite } from "../lib/api";
import { ApiError } from "../lib/errors";
import { loadRepairs, repairBoard, setRepairPaused } from "./repairs";
import { setActiveAccountId } from "./session";

vi.mock("../lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiWrite: vi.fn() }));
const at = "2026-10-03T00:00:00Z";
const row = (id: string, type: string, payload: Record<string, unknown>): Resource => ({
	id,
	type,
	payload,
	account_id: "a",
	status: "completed",
	repository: null,
	source_version: null,
	revision: 1,
	created_at: at,
	updated_at: at,
});
const cron = {
	schemaVersion: 1,
	expression: "0 * * * *",
	timezone: "UTC",
	enabled: true,
	paused: false,
	state: "idle",
	nextRunAt: at,
	lastRunAt: null,
	activeOccurrence: null,
	lastSeenAt: at,
	completed: 1,
	lastError: null,
	capability: "authorized-work",
	maxRounds: 20,
};
beforeEach(() => {
	vi.resetAllMocks();
	setActiveAccountId("a");
});
it("shows bounded work history, heartbeat and acknowledged pause separately", () => {
	const data = {
		account_id: "a",
		jobs: [
			row("run", "work-run", {
				occurrence: "cron-one",
				events: ["review round 20 exhausted; no push"],
				updatedAt: at,
			}),
		],
		cron: row("work-cron", "work-cron", cron),
		control: row("work-control", "work-control", { paused: true }),
	};
	expect(repairBoard(data, Date.parse(at))).toMatchObject({
		online: true,
		desiredPaused: true,
		pausePending: true,
	});
	expect(repairBoard(data, Date.parse(at) + 45001).online).toBe(false);
	expect(repairBoard({ ...data, cron: null, control: null }, 0).desiredPaused).toBe(false);
	expect(
		repairBoard(
			{ ...data, jobs: [row("bad", "work-run", {})], cron: row("bad", "work-cron", {}) },
			0,
		).errors,
	).toHaveLength(2);
	expect(
		repairBoard({ ...data, jobs: [{ ...(data.jobs[0] as Resource), account_id: "other" }] }, 0)
			.errors,
	).toHaveLength(1);
});
it("loads work jobs and updates only revision-protected pause control", async () => {
	vi.mocked(apiGet).mockImplementation(async (path) =>
		path === "accounts"
			? { accounts: [{ id: "a", is_active: true }] }
			: path.includes("/jobs?")
				? { account_id: "a", items: [], nextCursor: null }
				: {
						account_id: "a",
						item: row(path.endsWith("work-cron") ? "work-cron" : "work-control", "work-cron", cron),
					},
	);
	const data = await loadRepairs();
	expect(data.jobs).toEqual([]);
	vi.mocked(apiWrite).mockResolvedValue({
		account_id: "a",
		item: row("work-control", "work-control", { paused: true }),
	});
	await setRepairPaused("a", data.control, true);
	expect(apiWrite).toHaveBeenCalledWith("agent/accounts/a/records/work-control", "PATCH", {
		revision: 1,
		status: "paused",
		payload: { paused: true },
	});
	vi.mocked(apiPost).mockResolvedValue({
		account_id: "a",
		item: row("work-control", "work-control", { paused: false }),
	});
	await setRepairPaused("a", null, false);
	await expect(setRepairPaused("other", null, false)).rejects.toThrow("Account changed");
	vi.mocked(apiPost).mockResolvedValue({ account_id: "other" });
	await expect(setRepairPaused("a", null, false)).rejects.toThrow("Account changed");
});
it("preserves missing and failed evidence and rejects pagination/account changes", async () => {
	const accounts = { accounts: [{ id: "a", is_active: true }] };
	vi.mocked(apiGet).mockImplementation(async (path) => {
		if (path === "accounts") return accounts;
		if (path.includes("/records/")) throw new ApiError(404, "not_found", "missing");
		return { account_id: "a", items: [], nextCursor: "same" };
	});
	await expect(loadRepairs()).rejects.toThrow("pagination");
	vi.mocked(apiGet).mockImplementation(async (path) =>
		path === "accounts"
			? accounts
			: { account_id: "other", item: row("bad", "bad", {}), items: [], nextCursor: null },
	);
	await expect(loadRepairs()).rejects.toThrow("Account changed");
	vi.mocked(apiGet).mockImplementation(async (path) => {
		if (path === "accounts") return accounts;
		throw new Error("offline");
	});
	await expect(loadRepairs()).rejects.toThrow("offline");
});
