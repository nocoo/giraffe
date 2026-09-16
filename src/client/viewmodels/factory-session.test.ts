// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { factoryFixture } from "../../../tests/fixtures/factory-snapshot";
import { apiGet, apiPost } from "../lib/api";
import { ApiError } from "../lib/errors";
import {
	factoryError,
	formatFactoryCount,
	formatHours,
	formatObservedCount,
	formatRate,
	formatUtc,
	loadFactory,
	loadFactoryDetail,
	reloadFactory,
} from "./factory";
import { setActiveAccountId } from "./session";
import { clearSnapshots } from "./snapshot";

vi.mock("../lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
const snap = factoryFixture();
beforeEach(() => {
	clearSnapshots();
	setActiveAccountId(snap.account_id);
	vi.mocked(apiGet).mockImplementation(async (resource) =>
		resource === "accounts"
			? { accounts: [{ id: snap.account_id, login: "nocoo", is_active: true }] }
			: snap,
	);
	vi.mocked(apiPost).mockResolvedValue(snap);
});
afterEach(() => {
	vi.clearAllMocks();
	setActiveAccountId(null);
	clearSnapshots();
});
describe("factory account-bound data operations", () => {
	it("loads cached snapshots and explicitly reloads without triggering a refresh", async () => {
		expect(await loadFactory()).toEqual(snap);
		expect(await loadFactory()).toEqual(snap);
		expect(await reloadFactory()).toEqual(snap);
		expect(apiPost).not.toHaveBeenCalled();
	});
	it("loads filtered detail and ignores a late response after switching accounts", async () => {
		await loadFactoryDetail("nocoo/app", "prs");
		expect(apiGet).toHaveBeenCalledWith("factory/repos/nocoo/app/prs?page=1&state=&day=");
		await loadFactoryDetail("nocoo/app", "commits", 2, "open", "2026-09-01");
		expect(apiGet).toHaveBeenCalledWith(
			"factory/repos/nocoo/app/commits?page=2&state=open&day=2026-09-01",
		);
		vi.mocked(apiGet).mockImplementation(async (resource) => {
			if (resource === "accounts") return { accounts: [{ id: snap.account_id, is_active: true }] };
			return { ...snap, account_id: "other" };
		});
		expect(await loadFactoryDetail("nocoo/app", "prs")).toBeNull();
		vi.mocked(apiGet).mockImplementation(async (resource) => {
			if (resource === "accounts") return { accounts: [{ id: snap.account_id, is_active: true }] };
			setActiveAccountId("other");
			return snap;
		});
		expect(await loadFactoryDetail("nocoo/app", "prs")).toBeNull();
	});
	it("explains recoverable errors without exposing upstream messages", () => {
		for (const code of [
			"github_rate_limited",
			"account_conflict",
			"account_missing",
			"github_unauthorized",
			"internal_error",
			"refresh_cooldown",
			"catalog_incomplete",
			"factory_capacity",
		] as const)
			expect(factoryError(new ApiError(503, code, "secret"))).not.toContain("secret");
		expect(factoryError(new Error("secret"))).not.toContain("secret");
	});
	it("formats zero, unavailable, durations and UTC consistently", () => {
		expect(formatFactoryCount(15000)).toBe("15,000");
		expect(formatObservedCount(5000, false)).toBe("≥ 5,000");
		expect(formatObservedCount(0, true)).toBe("0");
		expect(formatHours(null)).toBe("—");
		expect(formatHours(1.25)).toBe("1.3 h");
		expect(formatHours(48)).toBe("2.0 d");
		expect(formatRate(null)).toBe("—");
		expect(formatRate(0)).toBe("0.0%");
		expect(formatUtc(null)).toBe("未采集");
		expect(formatUtc("2026-09-01T08:00:00+08:00")).toBe("2026-09-01 00:00:00 UTC");
	});
});
