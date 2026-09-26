// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { apiGet, apiPost } from "../lib/api";
import { loadRefreshSettings, saveRefreshSchedule, scheduleStatus } from "./refresh-settings";
import { setActiveAccountId } from "./session";

vi.mock("../lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
afterEach(() => {
	vi.resetAllMocks();
	setActiveAccountId(null);
});
it("loads and saves schedules without accepting results for a changed account", async () => {
	setActiveAccountId("a");
	vi.mocked(apiGet).mockResolvedValue({ account_id: "a", schedules: [], starred: [] });
	expect(await loadRefreshSettings("a")).toMatchObject({ account_id: "a" });
	vi.mocked(apiPost).mockResolvedValue({ account_id: "a", schedules: [], starred: [] });
	const config = { enabled: true, time: "08:00", weekday: 0, scope: "starred" as const };
	expect(await saveRefreshSchedule("a", "daily", config)).toMatchObject({ account_id: "a" });
	expect(apiPost).toHaveBeenCalledWith("refresh/schedules/daily", { account_id: "a", ...config });
	setActiveAccountId("b");
	await expect(saveRefreshSchedule("a", "daily", config)).rejects.toMatchObject({
		code: "account_conflict",
	});
	expect(await loadRefreshSettings("a")).toBeNull();
	setActiveAccountId("a");
	vi.mocked(apiPost).mockResolvedValue({ account_id: "b" });
	await expect(saveRefreshSchedule("a", "daily", config)).rejects.toMatchObject({
		code: "account_conflict",
	});
});
it("describes disabled, deferred, empty and ready schedules", () => {
	const schedule = {
		kind: "daily" as const,
		enabled: true,
		time: "08:00",
		weekday: 0,
		scope: "starred" as const,
		nextAt: null,
		lastError: null,
		lastRunId: null,
	};
	expect(scheduleStatus({ ...schedule, enabled: false })).toBe("已停用");
	expect(scheduleStatus({ ...schedule, lastError: "no_starred_repositories" })).toContain("星标");
	expect(scheduleStatus({ ...schedule, lastError: "account_conflict" })).toContain("等待");
	expect(scheduleStatus({ ...schedule, lastError: "catalog_incomplete" })).toContain("仓库列表");
	expect(scheduleStatus({ ...schedule, lastError: "internal_error" })).toContain("重试");
	expect(scheduleStatus(schedule)).toBe("等待首次安排");
	expect(scheduleStatus({ ...schedule, nextAt: "2026-09-28T00:00:00.000Z" })).toContain("2026");
});
