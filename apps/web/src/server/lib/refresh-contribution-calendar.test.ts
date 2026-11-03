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
					contributionCalendar: {
						totalContributions: 1,
						weeks: [{ contributionDays: [{ date: "2026-10-28", contributionCount: 3 }] }],
					},
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
		const result = await collectContributionCalendar(context, window, undefined, request as never);
		expect(request).toHaveBeenCalledTimes(chunks.length);
		expect(result.rawObserved.length).toBeGreaterThan(0);
		expect(result.chunkFailures).toEqual([]);
	});

	it("treats empty contribution weeks as chunk failure", async () => {
		const window = contributionWindow(now);
		const request = vi.fn(async () => ({
			viewer: {
				contributionsCollection: {
					restrictedContributionsCount: 0,
					contributionCalendar: { totalContributions: 0, weeks: [] },
				},
			},
			rateLimit: { remaining: 4999, resetAt: now },
		}));
		const context = {
			env: { ENVIRONMENT: "test" },
			account: { id: "a", login: "owner" },
			token: "fake",
			now,
			run: { params: { timezone: "Asia/Shanghai" } },
		} as CollectionContext;
		const result = await collectContributionCalendar(context, window, undefined, request as never);
		expect(result.rawObserved).toEqual([]);
		expect(
			result.chunkFailures.every((failure) => failure.code === "contributions:chunk_empty"),
		).toBe(true);
	});

	it("retains prior unchanged when every chunk fails and prior exists", async () => {
		const window = contributionWindow(now);
		const tip = window.until.slice(0, 10);
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
		expect(result.retainPrior).toBe(true);
		expect(result.materializedDays).toEqual([]);
		expect(result.rawObserved).toEqual([]);
		expect(result.materializedDays.some((day) => day.date === tip && day.count === 0)).toBe(false);
	});

	it("merges prior counts for a failed chunk when other chunks succeed", async () => {
		const window = contributionWindow(now);
		const chunks = contributionCalendarChunkWindows(window, "Asia/Shanghai");
		let calls = 0;
		const request = vi.fn(async () => {
			calls += 1;
			if (calls === 1) {
				throw new ApiError(502, "github_error", "calendar unavailable");
			}
			return {
				viewer: {
					contributionsCollection: {
						restrictedContributionsCount: 0,
						contributionCalendar: {
							totalContributions: 1,
							weeks: [{ contributionDays: [{ date: "2026-10-28", contributionCount: 2 }] }],
						},
					},
				},
				rateLimit: { remaining: 4999, resetAt: now },
			};
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
		expect(result.retainPrior).toBe(false);
		expect(result.partial).toBe(true);
		expect(result.materializedDays.find((day) => day.date === "2025-10-29")?.count).toBe(9);
		expect(request).toHaveBeenCalledTimes(chunks.length);
	});

	it("uses fallback calendar materialization when chunks fail without prior", async () => {
		const window = contributionWindow(now);
		const chunks = contributionCalendarChunkWindows(window, "Asia/Shanghai").length;
		const request = vi.fn(async () => {
			if (request.mock.calls.length <= chunks) {
				throw new ApiError(502, "github_error", "calendar unavailable");
			}
			return {
				viewer: {
					contributionsCollection: {
						restrictedContributionsCount: 0,
						contributionCalendar: {
							totalContributions: 1,
							weeks: [{ contributionDays: [{ date: "2026-10-28", contributionCount: 4 }] }],
						},
					},
				},
				rateLimit: { remaining: 4999, resetAt: now },
			};
		});
		const context = {
			env: { ENVIRONMENT: "test" },
			account: { id: "a", login: "owner" },
			token: "fake",
			now,
			run: { params: { timezone: "Asia/Shanghai" } },
		} as CollectionContext;
		const result = await collectContributionCalendar(context, window, undefined, request as never);
		expect(result.retainPrior).toBe(false);
		expect(result.rawObserved).toEqual([{ date: "2026-10-28", count: 4 }]);
		expect(result.partial).toBe(true);
		expect(request.mock.calls.length).toBe(chunks + 1);
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
