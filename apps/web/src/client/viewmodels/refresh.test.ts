import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RefreshRun } from "../../lib/refresh-types";
import { apiGet, apiPost } from "../lib/api";
import { ApiError } from "../lib/errors";
import {
	defaultRefreshParams,
	RefreshViewModel,
	refreshActive,
	refreshError,
	refreshProgress,
	refreshStatus,
	refreshTimezone,
	validateRefreshParams,
} from "./refresh";
import { setActiveAccountId } from "./session";

vi.mock("../lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

export function refreshRun(overrides: Partial<RefreshRun> = {}): RefreshRun {
	return {
		id: "run-1",
		accountId: "account-1",
		params: defaultRefreshParams(new Date("2026-10-29T04:00:00Z")),
		trigger: "manual",
		status: "running",
		phase: "account",
		repos: [],
		completedRepos: 0,
		requests: 1,
		requestBreakdown: {
			total: 1,
			graphql: 1,
			rest: 0,
			a: { graphql: 1, rest: 0 },
			b: { graphql: 0, rest: 0 },
		},
		partialReasons: [],
		partial: false,
		cancelRequested: false,
		errorCode: null,
		createdAt: "2026-10-29T04:00:00Z",
		updatedAt: "2026-10-29T04:00:00Z",
		finishedAt: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	setActiveAccountId("account-1");
});

describe("unified refresh parameters", () => {
	it("defaults to yesterday in the display timezone, including year and DST boundaries", () => {
		expect(defaultRefreshParams(new Date("2026-01-01T00:30:00Z"))).toEqual({
			since: "2025-12-31",
			until: "2025-12-31",
			timezone: "Asia/Shanghai",
			dimensions: ["commits", "issues", "prs", "actions", "releases", "alerts"],
			force: false,
		});
		expect(defaultRefreshParams(new Date("2026-10-28T17:00:00Z")).since).toBe("2026-10-28");
		expect(defaultRefreshParams(new Date("2026-03-09T05:30:00Z"), "America/New_York").since).toBe(
			"2026-03-08",
		);
		expect(
			defaultRefreshParams(new Date("2026-01-01T00:30:00Z"), "America/Los_Angeles").since,
		).toBe("2025-12-30");
	});

	it("validates actual calendar days, ordering, timezone, dimensions and adhoc repo", () => {
		const params = defaultRefreshParams();
		expect(validateRefreshParams(params)).toBeNull();
		expect(validateRefreshParams({ ...params, repo: "nocoo/giraffe" })).toBeNull();
		for (const date of ["", "2026-2-01", "2026-02-29", "2026-13-01"]) {
			expect(validateRefreshParams({ ...params, since: date })).toContain("日期");
			expect(validateRefreshParams({ ...params, until: date })).toContain("日期");
		}
		expect(
			validateRefreshParams({ ...params, since: "2026-12-31", until: "2026-01-01" }),
		).toContain("日期");
		expect(validateRefreshParams({ ...params, timezone: "Invalid/Timezone" })).toContain("时区");
		expect(validateRefreshParams({ ...params, timezone: "" })).toContain("时区");
		expect(validateRefreshParams({ ...params, dimensions: [] })).toContain("维度");
		for (const repo of ["bad", "../repo", "owner/..", "owner/repo/extra", "owner/repo?x"]) {
			expect(validateRefreshParams({ ...params, repo })).toContain("仓库");
		}
	});

	it("accepts at most 31 closed calendar days and rejects duplicate or unknown dimensions", () => {
		const now = new Date("2026-10-28T17:00:00Z");
		const params = defaultRefreshParams(now);
		expect(validateRefreshParams({ ...params, since: "2026-09-28" }, now)).toBeNull();
		expect(validateRefreshParams({ ...params, since: "2026-09-27" }, now)).toContain("31");
		expect(validateRefreshParams({ ...params, until: "2026-10-29" }, now)).toContain("今天");
		expect(validateRefreshParams({ ...params, until: "2027-01-01" }, now)).toContain("未来");
		expect(validateRefreshParams({ ...params, timezone: "America/Los_Angeles" }, now)).toContain(
			"今天",
		);
		expect(validateRefreshParams({ ...params, dimensions: ["commits", "commits"] }, now)).toContain(
			"重复",
		);
		expect(
			validateRefreshParams({ ...params, dimensions: ["dependencies" as never] }, now),
		).toContain("维度");
	});

	it("resets dates to yesterday when changing timezone without changing dimensions or force", () => {
		const now = new Date("2026-10-28T17:00:00Z");
		const params = { ...defaultRefreshParams(now), force: true, dimensions: ["commits" as const] };
		expect(refreshTimezone(params, "America/Los_Angeles", now)).toEqual({
			...params,
			timezone: "America/Los_Angeles",
			since: "2026-10-27",
			until: "2026-10-27",
		});
		expect(refreshTimezone(params, "Invalid/Timezone", now)).toEqual({
			...params,
			timezone: "Invalid/Timezone",
		});
	});

	it("describes account-first and serial repo progress without fabricated percentages", () => {
		expect(refreshProgress(refreshRun())).toBe("A · 账号信息、贡献趋势与仓库清单");
		expect(
			refreshProgress(refreshRun({ phase: "repos", repos: ["a/b", "a/c"], completedRepos: 1 })),
		).toBe("B · 仓库串行刷新 1 / 2");
		expect(refreshProgress(refreshRun({ phase: "done" }))).toBe("刷新结束");
		for (const [status, label] of [
			["queued", "排队中"],
			["running", "刷新中"],
			["completed", "已完成"],
			["partial", "部分完成"],
			["failed", "刷新失败"],
			["cancelled", "已取消"],
		] as const)
			expect(refreshStatus(refreshRun({ status }))).toBe(label);
	});

	it("shows only safe actionable errors", () => {
		expect(refreshError(new ApiError(409, "account_missing", "secret"))).toContain("设置");
		expect(refreshError(new ApiError(403, "local_read_only", "secret"))).toContain("只读");
		expect(refreshError(new ApiError(401, "access_unauthorized", "secret"))).toContain("Access");
		expect(refreshError(new ApiError(409, "account_conflict", "secret"))).toContain("状态");
		expect(refreshError(new Error("secret"))).not.toContain("secret");
	});
});

describe("refresh viewmodel", () => {
	it.each([409, 404])(
		"reconciles an externally switched account after polling %s using GET only",
		async (status) => {
			const model = new RefreshViewModel();
			vi.mocked(apiGet).mockResolvedValueOnce({ items: [refreshRun()], collectionAvailable: true });
			await model.read();
			vi.mocked(apiGet)
				.mockRejectedValueOnce(
					new ApiError(status, status === 404 ? "not_found" : "account_conflict", "changed"),
				)
				.mockResolvedValueOnce({ accounts: [{ id: "account-2", is_active: true }] })
				.mockResolvedValueOnce({
					items: [refreshRun({ id: "run-2", accountId: "account-2" })],
					collectionAvailable: true,
				});
			await model.read();
			await vi.waitFor(() => expect(model.getSnapshot().run?.id).toBe("run-2"));
			expect(apiGet).toHaveBeenCalledWith("accounts");
			expect(model.getSnapshot()).toMatchObject({
				accountId: "account-2",
				ready: true,
				error: null,
			});
			expect(apiPost).not.toHaveBeenCalled();
		},
	);
	it("reconciles a POST account conflict without ever retrying the write", async () => {
		const model = new RefreshViewModel();
		vi.mocked(apiGet)
			.mockResolvedValueOnce({ items: [], collectionAvailable: true })
			.mockRejectedValueOnce(new ApiError(409, "snapshot_missing", "missing"));
		await model.read();
		vi.mocked(apiPost).mockRejectedValueOnce(new ApiError(409, "account_conflict", "changed"));
		vi.mocked(apiGet)
			.mockResolvedValueOnce({ accounts: [{ id: "account-2", is_active: true }] })
			.mockResolvedValueOnce({
				items: [refreshRun({ id: "run-2", accountId: "account-2" })],
				collectionAvailable: true,
			});
		await model.start(defaultRefreshParams());
		await vi.waitFor(() => expect(model.getSnapshot().run?.id).toBe("run-2"));
		expect(apiPost).toHaveBeenCalledOnce();
	});
	it("does not accept stale session reconciliation after a newer account switch", async () => {
		const model = new RefreshViewModel();
		vi.mocked(apiGet).mockResolvedValueOnce({ items: [refreshRun()], collectionAvailable: true });
		await model.read();
		let finish: ((body: unknown) => void) | undefined;
		vi.mocked(apiGet)
			.mockRejectedValueOnce(new ApiError(409, "account_conflict", "changed"))
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			)
			.mockResolvedValueOnce({
				items: [refreshRun({ id: "run-3", accountId: "account-3" })],
				collectionAvailable: true,
			});
		const reading = model.read();
		await vi.waitFor(() => expect(apiGet).toHaveBeenLastCalledWith("accounts"));
		setActiveAccountId("account-3");
		finish?.({ accounts: [{ id: "account-2", is_active: true }] });
		await reading;
		await vi.waitFor(() => expect(model.getSnapshot().run?.id).toBe("run-3"));
		expect(model.getSnapshot().accountId).toBe("account-3");
		expect(apiPost).not.toHaveBeenCalled();
	});
	it("resolves the account before reading and exposes absent account failures", async () => {
		setActiveAccountId(null);
		vi.mocked(apiGet)
			.mockResolvedValueOnce({ accounts: [{ id: "account-1", is_active: true }] })
			.mockResolvedValueOnce({ items: [refreshRun()], collectionAvailable: true });
		const model = new RefreshViewModel();
		await model.read();
		expect(model.getSnapshot().accountId).toBe("account-1");
		setActiveAccountId(null);
		vi.mocked(apiGet).mockResolvedValueOnce({ accounts: [] });
		model.accountChanged();
		await vi.waitFor(() => expect(model.getSnapshot().loading).toBe(false));
		expect(model.getSnapshot().error).toContain("设置");
	});

	it("does not start while unavailable, while a read is pending, or before a failed read is retried", async () => {
		vi.mocked(apiGet)
			.mockResolvedValueOnce({ items: [], collectionAvailable: false })
			.mockRejectedValueOnce(new ApiError(409, "snapshot_missing", "missing"));
		const model = new RefreshViewModel();
		await model.read();
		await model.start(defaultRefreshParams());
		expect(apiPost).not.toHaveBeenCalled();
		vi.mocked(apiGet)
			.mockResolvedValueOnce({ items: [], collectionAvailable: true })
			.mockRejectedValueOnce(new Error("unavailable"));
		await model.read();
		await model.start(defaultRefreshParams());
		expect(apiPost).not.toHaveBeenCalled();
		expect(model.getSnapshot().error).toContain("重试");
		let finish: ((value: unknown) => void) | undefined;
		vi.mocked(apiGet)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			)
			.mockResolvedValueOnce(refreshRun({ status: "completed" }));
		const read = model.read();
		await model.start(defaultRefreshParams());
		expect(apiPost).not.toHaveBeenCalled();
		finish?.({ items: [], collectionAvailable: true });
		await read;
		expect(model.getSnapshot().ready).toBe(true);
	});

	it("rereads instead of posting stale account parameters", async () => {
		vi.mocked(apiGet)
			.mockResolvedValueOnce({
				items: [refreshRun({ status: "completed" })],
				collectionAvailable: true,
			})
			.mockResolvedValueOnce(refreshRun({ status: "completed" }));
		const model = new RefreshViewModel();
		await model.read();
		setActiveAccountId("other");
		vi.mocked(apiGet).mockResolvedValueOnce({
			items: [refreshRun({ accountId: "other" })],
			collectionAvailable: true,
		});
		await model.start(defaultRefreshParams());
		expect(apiPost).not.toHaveBeenCalled();
		expect(model.getSnapshot().run?.accountId).toBe("other");
	});

	it("rejects a POST response for another account", async () => {
		vi.mocked(apiGet)
			.mockResolvedValueOnce({ items: [], collectionAvailable: true })
			.mockRejectedValueOnce(new ApiError(409, "snapshot_missing", "missing"));
		const model = new RefreshViewModel();
		await model.read();
		vi.mocked(apiPost).mockResolvedValueOnce(refreshRun({ accountId: "other" }));
		await model.start(defaultRefreshParams());
		expect(model.getSnapshot()).toMatchObject({ run: null, ready: false });
		expect(model.getSnapshot().error).toContain("状态");
	});

	it.each([false, true])(
		"discards a late POST response or rejection after switching accounts: %s",
		async (reject) => {
			vi.mocked(apiGet)
				.mockResolvedValueOnce({ items: [], collectionAvailable: true })
				.mockRejectedValueOnce(new ApiError(409, "snapshot_missing", "missing"));
			const model = new RefreshViewModel();
			await model.read();
			let finish: ((value: RefreshRun) => void) | undefined;
			let fail: ((error: Error) => void) | undefined;
			vi.mocked(apiPost).mockImplementationOnce(
				() =>
					new Promise((resolve, rejection) => {
						finish = resolve;
						fail = rejection;
					}),
			);
			const started = model.start(defaultRefreshParams());
			setActiveAccountId("other");
			model.accountChanged();
			vi.mocked(apiGet).mockResolvedValueOnce({
				items: [refreshRun({ accountId: "other" })],
				collectionAvailable: true,
			});
			if (reject) fail?.(new Error("secret"));
			else finish?.(refreshRun());
			await started;
			await vi.waitFor(() => expect(model.getSnapshot().run?.accountId).toBe("other"));
			expect(model.getSnapshot().error).toBeNull();
		},
	);

	it.each([false, true])(
		"discards a late polling response or failure after switching accounts: %s",
		async (reject) => {
			vi.mocked(apiGet).mockResolvedValueOnce({ items: [refreshRun()], collectionAvailable: true });
			const model = new RefreshViewModel();
			await model.read();
			let finish: ((value: RefreshRun) => void) | undefined;
			let fail: ((error: Error) => void) | undefined;
			vi.mocked(apiGet).mockImplementationOnce(
				() =>
					new Promise((resolve, rejection) => {
						finish = resolve;
						fail = rejection;
					}),
			);
			const read = model.read();
			setActiveAccountId("other");
			model.accountChanged();
			vi.mocked(apiGet).mockResolvedValueOnce({
				items: [refreshRun({ accountId: "other" })],
				collectionAvailable: true,
			});
			if (reject) fail?.(new Error("secret"));
			else finish?.(refreshRun());
			await read;
			await vi.waitFor(() => expect(model.getSnapshot().run?.accountId).toBe("other"));
			expect(model.getSnapshot().error).toBeNull();
		},
	);
	it("reads existing runs without POST and handles an absent latest snapshot", async () => {
		vi.mocked(apiGet)
			.mockResolvedValueOnce({ items: [], collectionAvailable: true })
			.mockRejectedValueOnce(new ApiError(409, "snapshot_missing", "missing"));
		const model = new RefreshViewModel();
		const notify = vi.fn();
		const stop = model.subscribe(notify);
		await model.read();
		expect(model.getSnapshot()).toMatchObject({ loading: false, run: null, error: null });
		expect(apiGet).toHaveBeenNthCalledWith(1, "refresh-runs");
		expect(apiGet).toHaveBeenNthCalledWith(2, "refresh-runs/latest");
		expect(apiPost).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalled();
		stop();
	});

	it("prevents overlapping starts and reads, polls by id and reloads data once on terminal", async () => {
		vi.mocked(apiGet)
			.mockResolvedValueOnce({ items: [], collectionAvailable: true })
			.mockRejectedValueOnce(new ApiError(409, "snapshot_missing", "missing"));
		const model = new RefreshViewModel();
		await model.start(defaultRefreshParams());
		expect(apiPost).not.toHaveBeenCalled();
		await model.read();
		let finish: ((run: RefreshRun) => void) | undefined;
		vi.mocked(apiPost).mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const params = { ...defaultRefreshParams(), repo: "nocoo/giraffe", force: true };
		const started = model.start(params);
		await model.start(params);
		await model.read();
		expect(model.getSnapshot().starting).toBe(true);
		expect(apiPost).toHaveBeenCalledTimes(1);
		expect(apiPost).toHaveBeenCalledWith("refresh-runs", params);
		finish?.(refreshRun({ status: "queued" }));
		await started;
		await model.start(params);
		expect(apiPost).toHaveBeenCalledTimes(1);
		const refreshed = vi.fn();
		const stop = model.subscribeData(refreshed);
		vi.mocked(apiGet).mockResolvedValue(
			refreshRun({ status: "partial", phase: "done", errorCode: "github_error" }),
		);
		await model.read();
		expect(apiGet).toHaveBeenLastCalledWith("refresh-runs/run-1");
		expect(refreshed).toHaveBeenCalledTimes(1);
		vi.mocked(apiGet)
			.mockResolvedValueOnce({ items: [], collectionAvailable: true })
			.mockResolvedValueOnce(refreshRun({ status: "partial", phase: "done" }));
		await model.read();
		expect(refreshed).toHaveBeenCalledTimes(1);
		stop();
	});

	it.each(["completed", "partial", "failed"] as const)(
		"revalidates on %s and accepts externally started tasks",
		async (status) => {
			const run = refreshRun();
			vi.mocked(apiGet).mockResolvedValueOnce({ items: [run], collectionAvailable: true });
			const model = new RefreshViewModel();
			const refreshed = vi.fn();
			model.subscribeData(refreshed);
			await model.read();
			expect(refreshed).not.toHaveBeenCalled();
			vi.mocked(apiGet).mockResolvedValueOnce(refreshRun({ status, phase: "done" }));
			await model.read();
			expect(refreshed).toHaveBeenCalledOnce();
		},
	);

	it("does not revalidate initial saved runs but revalidates a newly completed external run", async () => {
		const model = new RefreshViewModel();
		const refreshed = vi.fn();
		model.subscribeData(refreshed);
		vi.mocked(apiGet)
			.mockResolvedValueOnce({ items: [], collectionAvailable: true })
			.mockResolvedValueOnce(refreshRun({ status: "completed", phase: "done" }));
		await model.read();
		expect(refreshed).not.toHaveBeenCalled();
		vi.mocked(apiGet)
			.mockResolvedValueOnce({ items: [], collectionAvailable: true })
			.mockResolvedValueOnce(refreshRun({ id: "run-2", status: "completed", phase: "done" }));
		await model.read();
		expect(refreshed).toHaveBeenCalledOnce();
	});

	it("keeps failed polling visible and retries only GET", async () => {
		vi.mocked(apiGet).mockResolvedValueOnce({ items: [refreshRun()], collectionAvailable: true });
		const model = new RefreshViewModel();
		await model.read();
		vi.mocked(apiGet).mockRejectedValueOnce(new Error("secret"));
		await model.read();
		expect(model.getSnapshot()).toMatchObject({ run: { id: "run-1" }, starting: false });
		expect(model.getSnapshot().error).toContain("重试");
		vi.mocked(apiGet).mockResolvedValueOnce(refreshRun());
		await model.read();
		expect(model.getSnapshot().error).toBeNull();
		expect(apiPost).not.toHaveBeenCalled();
	});

	it("rejects invalid starts and exposes POST failures without retrying POST", async () => {
		vi.mocked(apiGet)
			.mockResolvedValueOnce({ items: [], collectionAvailable: true })
			.mockRejectedValueOnce(new ApiError(409, "snapshot_missing", "missing"));
		const model = new RefreshViewModel();
		await model.read();
		await model.start({ ...defaultRefreshParams(), dimensions: [] });
		expect(apiPost).not.toHaveBeenCalled();
		expect(model.getSnapshot().error).toContain("维度");
		vi.mocked(apiPost).mockRejectedValueOnce(new Error("secret"));
		await model.start(defaultRefreshParams());
		expect(model.getSnapshot().starting).toBe(false);
		expect(model.getSnapshot().error).not.toContain("secret");
		expect(apiPost).toHaveBeenCalledOnce();
	});

	it("ignores late responses after account switching, including switching away and back", async () => {
		let finish: ((body: unknown) => void) | undefined;
		vi.mocked(apiGet).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const model = new RefreshViewModel();
		const read = model.read();
		await model.read();
		setActiveAccountId("other");
		setActiveAccountId("account-1");
		finish?.({ items: [refreshRun()], collectionAvailable: true });
		await read;
		expect(model.getSnapshot().run).toBeNull();
		vi.mocked(apiGet).mockResolvedValueOnce({
			items: [refreshRun({ accountId: "other" })],
			collectionAvailable: true,
		});
		await model.read();
		expect(model.getSnapshot().run).toBeNull();
		expect(model.getSnapshot().error).toContain("状态");
	});

	it("unlocks polling and shows the terminal cancelled state after a machine cancel", async () => {
		vi.mocked(apiGet).mockResolvedValueOnce({ items: [refreshRun()], collectionAvailable: true });
		const model = new RefreshViewModel();
		const refreshed = vi.fn();
		model.subscribeData(refreshed);
		await model.read();
		const cancelled = refreshRun({
			status: "cancelled",
			phase: "done",
			cancelRequested: true,
			finishedAt: "2026-10-29T04:10:00Z",
		});
		expect(refreshActive(cancelled)).toBe(false);
		expect(refreshStatus(cancelled)).toBe("已取消");
		vi.mocked(apiGet).mockResolvedValueOnce({
			...cancelled,
			requestBreakdown: cancelled.requestBreakdown,
		});
		await model.read();
		expect(model.getSnapshot().run).toMatchObject({ status: "cancelled", phase: "done" });
		expect(refreshed).toHaveBeenCalledOnce();
		vi.mocked(apiGet)
			.mockResolvedValueOnce({ items: [], collectionAvailable: true })
			.mockResolvedValueOnce(cancelled);
		await model.read();
		expect(apiGet).toHaveBeenLastCalledWith("refresh-runs/latest");
		expect(apiPost).not.toHaveBeenCalled();
	});
});
