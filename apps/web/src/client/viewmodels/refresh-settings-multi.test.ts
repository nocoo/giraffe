// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { apiPost } from "../lib/api";
import { saveRefreshSchedule } from "./refresh-settings";
import { setActiveAccountId } from "./session";

vi.mock("../lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
afterEach(() => {
	vi.resetAllMocks();
	setActiveAccountId(null);
});

it("derives the legacy alias from edited slots before submitting the schedule", async () => {
	setActiveAccountId("a");
	vi.mocked(apiPost).mockResolvedValue({ account_id: "a", schedules: [], starred: [] });
	await saveRefreshSchedule("a", "daily", {
		enabled: true,
		time: "08:00",
		times: ["19:30", "05:30", "05:30"],
		weekday: 0,
		scope: "starred",
	});
	expect(apiPost).toHaveBeenCalledWith("refresh/schedules/daily", {
		account_id: "a",
		enabled: true,
		time: "05:30",
		times: ["05:30", "19:30"],
		weekday: 0,
		scope: "starred",
	});
});
