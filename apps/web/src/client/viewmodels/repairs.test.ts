import type { Resource } from "@nocoo/giraffe-agent/contracts";
import type { CronStatus, RepairProgress } from "@nocoo/giraffe-agent/repair-contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { apiGet, apiPost, apiWrite } from "../lib/api";
import { loadRepairs, repairBoard, repairLinks, setRepairPaused, signoffMatches } from "./repairs";
import { setActiveAccountId } from "./session";

vi.mock("../lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiWrite: vi.fn() }));
const at = "2026-10-02T08:00:00Z";
const row = (id: string, type: string, payload: unknown): Resource => ({
	id,
	type,
	account_id: "a",
	status: "pending",
	repository: null,
	source_version: null,
	payload: payload as Resource["payload"],
	revision: 1,
	created_at: at,
	updated_at: at,
});
const progress: RepairProgress = {
	schemaVersion: 1,
	id: "job",
	repository: "nocoo/app",
	issueNumber: 1,
	title: "Upgrade demo",
	issueUrl: "https://github.com/nocoo/app/issues/1",
	stage: "blocked",
	round: 0,
	maxRounds: 20,
	branch: null,
	head: null,
	contentFingerprint: null,
	workerConversationId: null,
	reviewerConversationId: null,
	startedAt: at,
	updatedAt: at,
	sequence: 1,
	reason: "Required local package manager or check profile unavailable",
	plan: null,
	review: null,
	events: [],
};
const cron: CronStatus = {
	schemaVersion: 1,
	expression: "0 * * * *",
	timezone: "Asia/Shanghai",
	enabled: false,
	paused: false,
	state: "idle",
	nextRunAt: at,
	lastRunAt: null,
	activeOccurrence: null,
	lastSeenAt: at,
	completed: 0,
	lastError: null,
	capability: "dependency-upgrades",
	maxRounds: 20,
};
beforeEach(() => {
	vi.clearAllMocks();
	setActiveAccountId("a");
});
it("distinguishes configured cron, stale heartbeat and desired pause from acknowledged state", () => {
	const data = {
		account_id: "a",
		jobs: [
			{ ...row("job", "dependency-repair", progress), repository: "nocoo/app", status: "blocked" },
		],
		cron: row("repair-cron", "repair-cron", cron),
		control: row("repair-control", "repair-control", { paused: true }),
	};
	expect(repairBoard(data, Date.parse(at) + 45000)).toMatchObject({
		online: true,
		desiredPaused: true,
		pausePending: true,
		counts: { blocked: 1, pushed: 0 },
	});
	expect(repairBoard(data, Date.parse(at) + 45001).online).toBe(false);
	expect(repairBoard({ ...data, cron: null }, Date.parse(at)).online).toBe(false);
	expect(
		repairBoard(
			{
				...data,
				jobs: [row("bad", "dependency-repair", {})],
				cron: row("repair-cron", "repair-cron", {}),
			},
			Date.parse(at),
		).errors,
	).toHaveLength(2);
});
it("rejects mismatched identities, impossible rounds and stale signoffs without conflating signoff with push", () => {
	const head = "a".repeat(40);
	const signed = {
		...progress,
		stage: "signed_off" as const,
		round: 2,
		head,
		contentFingerprint: "fp",
		review: {
			verdict: "signoff" as const,
			summary: "checked",
			findings: [],
			head,
			contentFingerprint: "fp",
			validationDigest: "proof",
			reviewedRound: 2,
		},
	};
	expect(signoffMatches(signed)).toBe(true);
	expect(signoffMatches({ ...signed, head: "b".repeat(40) })).toBe(false);
	expect(signoffMatches({ ...signed, round: 3 })).toBe(false);
	expect(signoffMatches(progress)).toBe(false);
	const data = {
		account_id: "a",
		jobs: [
			{ ...row("job", "dependency-repair", signed), repository: "nocoo/app", status: "signed_off" },
		],
		cron: null,
		control: null,
	};
	expect(repairBoard(data, 0).counts.pushed).toBe(0);
	expect(
		repairBoard({ ...data, jobs: [row("other", "dependency-repair", progress)] }, 0).errors,
	).toHaveLength(1);
	expect(
		repairBoard(
			{ ...data, jobs: [{ ...(data.jobs[0] as Resource), payload: { ...signed, maxRounds: 1 } }] },
			0,
		).errors,
	).toHaveLength(1);
	expect(repairLinks({ ...progress, issueUrl: "javascript:alert(1)", branch: "main" })).toEqual({
		issue: null,
		branch: null,
	});
	expect(repairLinks({ ...progress, branch: "giraffe/deps-1-abc" })).toMatchObject({
		issue: progress.issueUrl,
		branch: "https://github.com/nocoo/app/tree/giraffe/deps-1-abc",
	});
});
it("loads paginated repair jobs and updates only the pause record with optimistic revision", async () => {
	vi.mocked(apiGet).mockImplementation(async (path) =>
		path === "accounts"
			? { accounts: [{ id: "a", is_active: true }] }
			: path.includes("/jobs?")
				? { account_id: "a", items: [], nextCursor: null }
				: {
						account_id: "a",
						item: row(
							path.endsWith("repair-cron") ? "repair-cron" : "repair-control",
							path.endsWith("repair-cron") ? "repair-cron" : "repair-control",
							path.endsWith("repair-cron") ? cron : { paused: false },
						),
					},
	);
	const data = await loadRepairs();
	expect(data.jobs).toEqual([]);
	vi.mocked(apiWrite).mockResolvedValue({
		account_id: "a",
		item: row("repair-control", "repair-control", { paused: true }),
	});
	await setRepairPaused("a", data.control, true);
	expect(apiWrite).toHaveBeenCalledWith("agent/accounts/a/records/repair-control", "PATCH", {
		revision: 1,
		status: "paused",
		payload: { paused: true },
	});
	vi.mocked(apiPost).mockResolvedValue({
		account_id: "a",
		item: row("repair-control", "repair-control", { paused: false }),
	});
	await setRepairPaused("a", null, false);
	expect(apiPost).toHaveBeenCalledWith("agent/accounts/a/records", {
		id: "repair-control",
		type: "repair-control",
		status: "enabled",
		repository: null,
		source_version: null,
		payload: { paused: false },
	});
	setActiveAccountId("b");
	await expect(setRepairPaused("a", null, true)).rejects.toThrow();
});

it("reports malformed controls, error/offline/future cron and chronological job events", () => {
	const later = {
		...progress,
		id: "later",
		stage: "pushed" as const,
		updatedAt: "2026-10-02T09:00:00Z",
		events: [
			{ at: "2026-10-02T09:00:00Z", stage: "pushed" as const, round: 1, message: "last" },
			{ at, stage: "planning" as const, round: 0, message: "first" },
		],
	};
	const jobs = [
		{
			...row("job", "dependency-repair", progress),
			repository: progress.repository,
			status: progress.stage,
		},
		{
			...row("later", "dependency-repair", later),
			repository: later.repository,
			status: later.stage,
		},
	];
	const board = repairBoard(
		{
			account_id: "a",
			jobs,
			cron: row("repair-cron", "repair-cron", { ...cron, state: "offline" }),
			control: row("repair-control", "repair-control", { paused: "yes" }),
		},
		Date.parse(at),
	);
	expect(board.online).toBe(false);
	expect(board.errors).toHaveLength(1);
	expect(board.jobs[0]?.events[0]?.message).toBe("first");
	expect(board.counts.pushed).toBe(1);
	expect(
		repairBoard(
			{ account_id: "a", jobs: [], cron: row("repair-cron", "repair-cron", cron), control: null },
			Date.parse(at) - 61000,
		).online,
	).toBe(false);
	expect(repairLinks({ ...progress, issueUrl: "bad" }).issue).toBeNull();
});
it("handles missing records, account conflicts, invalid pagination and failed pause writes without elevating permissions", async () => {
	const { ApiError } = await import("../lib/errors");
	vi.mocked(apiGet).mockImplementation(async (path) => {
		if (path === "accounts") return { accounts: [{ id: "a", is_active: true }] };
		if (path.includes("/records/")) throw new ApiError(404, "not_found", "missing");
		return { account_id: "a", items: [], nextCursor: null };
	});
	expect(await loadRepairs()).toMatchObject({ cron: null, control: null, jobs: [] });
	for (const mode of ["foreign", "record", "repeat", "limit", "error"]) {
		let cursor = 0;
		vi.mocked(apiGet).mockImplementation(async (path) => {
			if (path === "accounts") return { accounts: [{ id: "a", is_active: true }] };
			if (path.includes("/records/")) {
				if (mode === "error") throw new Error("offline");
				return {
					account_id: mode === "record" ? "b" : "a",
					item: row("repair-cron", "repair-cron", cron),
				};
			}
			return {
				account_id: mode === "foreign" ? "b" : "a",
				items: [],
				nextCursor: mode === "repeat" ? "same" : mode === "limit" ? String(++cursor) : null,
			};
		});
		await expect(loadRepairs()).rejects.toThrow();
	}
	vi.mocked(apiPost).mockResolvedValue({
		account_id: "b",
		item: row("repair-control", "repair-control", { paused: true }),
	});
	await expect(setRepairPaused("a", null, true)).rejects.toThrow("Account changed");
	await expect(
		setRepairPaused("a", { ...row("repair-control", "repair-control", {}), account_id: "b" }, true),
	).rejects.toThrow("Account changed");
});

it("rejects malformed timezones and event dates before formatting them in the view", () => {
	const invalid = {
		...progress,
		events: [{ at: "not-time", stage: "blocked" as const, round: 0, message: "invalid" }],
	};
	expect(
		repairBoard(
			{
				account_id: "a",
				jobs: [
					{
						...row("job", "dependency-repair", invalid),
						repository: progress.repository,
						status: progress.stage,
					},
				],
				cron: row("repair-cron", "repair-cron", { ...cron, timezone: "not/a/zone" }),
				control: null,
			},
			0,
		).errors,
	).toHaveLength(2);
});
