import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { contributionCalendarChunkWindows, contributionWindow } from "./refresh-calendar";
import type { CollectionContext } from "./refresh-collection-contract";
import { collectContributionCalendar } from "./refresh-contribution-calendar";

const now = "2026-10-29T04:00:00.000Z";

describe("collectContributionCalendar", () => {
	it("queries GitHub once per Shanghai-aligned chunk in production mode", async () => {
		const window = contributionWindow(now);
		const chunks = contributionCalendarChunkWindows(window, "Asia/Shanghai");
		const request = vi.fn(async (_client: unknown) => ({
			viewer: {
				contributionsCollection: {
					restrictedContributionsCount: 0,
					contributionCalendar: { totalContributions: 0, weeks: [] },
				},
			},
			rateLimit: { remaining: 4999, resetAt: now },
		}));
		const context = {
			env: { ENVIRONMENT: "production" },
			account: { id: "a", login: "owner" },
			token: "fake",
			now,
			run: { params: { timezone: "Asia/Shanghai" } },
		} as CollectionContext;
		await collectContributionCalendar(context, window, undefined, request as never);
		expect(request).toHaveBeenCalledTimes(chunks.length);
	});

	it("merges prior day counts when a chunk request fails", async () => {
		const window = contributionWindow(now);
		const request = vi.fn(async () => {
			throw new ApiError(502, "github_error", "calendar unavailable");
		});
		const context = {
			env: { ENVIRONMENT: "test" },
			account: { id: "a", login: "owner" },
			token: "fake",
			now,
			run: { params: { timezone: "Asia/Shanghai" } },
		} as CollectionContext;
		const prior = [{ date: "2025-10-29", count: 9 }];
		const result = await collectContributionCalendar(context, window, prior, request as never);
		expect(result.partial).toBe(true);
		expect(result.materializedDays.find((day) => day.date === "2025-10-29")?.count).toBe(9);
	});

	it("rethrows unexpected calendar transport errors", async () => {
		const window = contributionWindow(now);
		const request = vi.fn(async () => {
			throw new TypeError("network");
		});
		const context = {
			env: { ENVIRONMENT: "test" },
			account: { id: "a", login: "owner" },
			token: "fake",
			now,
			run: { params: { timezone: "Asia/Shanghai" } },
		} as CollectionContext;
		await expect(
			collectContributionCalendar(context, window, undefined, request as never),
		).rejects.toThrow("network");
	});
});
