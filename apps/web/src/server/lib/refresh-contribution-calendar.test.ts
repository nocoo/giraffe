import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { createGithubClient } from "./github-client";
import { contributionCalendarChunkWindows, contributionWindow } from "./refresh-calendar";
import { transport } from "./refresh-collection/transport";
import type { CollectionContext } from "./refresh-collection-contract";
import {
	collectContributionCalendar,
	dedupeChunkContributionDays,
} from "./refresh-contribution-calendar";

const now = "2026-10-29T04:00:00.000Z";

describe("dedupeChunkContributionDays", () => {
	it("prefers the later chunk when Shanghai overlap days appear in adjacent chunks", () => {
		const chunks = [
			{ since: "2026-10-04T16:00:00.000Z", until: "2026-11-01T16:00:00.000Z" },
			{ since: "2026-11-01T16:00:00.000Z", until: "2026-11-28T16:00:00.000Z" },
		];
		const deduped = dedupeChunkContributionDays(chunks, "Asia/Shanghai", [
			{ date: "2026-11-01", count: 100, chunkIndex: 0 },
			{ date: "2026-11-01", count: 174, chunkIndex: 1 },
		]);
		expect(deduped).toEqual([{ date: "2026-11-01", count: 174 }]);
	});

	it("prefers the chunk where the Shanghai day is fully inside when the later chunk only overlaps the boundary", () => {
		const chunks = [
			{ since: "2026-10-04T16:00:00.000Z", until: "2026-11-01T16:00:00.000Z" },
			{ since: "2026-11-01T16:00:00.000Z", until: "2026-11-28T16:00:00.000Z" },
		];
		const deduped = dedupeChunkContributionDays(chunks, "Asia/Shanghai", [
			{ date: "2026-11-01", count: 174, chunkIndex: 1 },
			{ date: "2026-11-01", count: 100, chunkIndex: 0 },
		]);
		expect(deduped).toEqual([{ date: "2026-11-01", count: 100 }]);
	});

	it("ignores entries whose chunk index is out of range", () => {
		const chunks = [{ since: "2026-10-04T16:00:00.000Z", until: "2026-11-01T16:00:00.000Z" }];
		expect(
			dedupeChunkContributionDays(chunks, "Asia/Shanghai", [
				{ date: "2026-10-05", count: 1, chunkIndex: 99 },
			]),
		).toEqual([]);
	});
});

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

	it("parses a GitHub-shaped chunk response through the real transport and github client", async () => {
		const window = contributionWindow(now);
		const chunk = contributionCalendarChunkWindows(window, "Asia/Shanghai")[0];
		if (!chunk) throw new Error("expected chunk");
		const githubPayload = {
			data: {
				viewer: {
					contributionsCollection: {
						restrictedContributionsCount: 0,
						contributionCalendar: {
							totalContributions: 394,
							weeks: [
								{
									contributionDays: [
										{ date: "2026-10-28", contributionCount: 394, color: "#196127" },
										{ date: "2026-10-27", contributionCount: 174, color: "#239a3b" },
									],
								},
							],
						},
					},
				},
			},
		};
		const base = "http://127.0.0.1:17046";
		const fetch = vi.fn(async () => Response.json(githubPayload));
		const context = {
			env: { ENVIRONMENT: "development", GITHUB_API_BASE: base },
			account: { id: "a", login: "owner" },
			token: "fake",
			now,
			run: { params: { timezone: "Asia/Shanghai" } },
		} as CollectionContext;
		const { request } = transport(context);
		const client = createGithubClient(context.env, fetch);
		const wrapped = async <Result>(
			operation: (github: typeof client) => Promise<Result>,
			dimension?: string,
		) => request(() => operation(client), dimension);
		const result = await collectContributionCalendar(
			context,
			window,
			[{ date: "2026-10-28", count: 0 }],
			wrapped,
		);
		expect(result.rawObserved).toEqual(
			expect.arrayContaining([
				{ date: "2026-10-28", count: 394 },
				{ date: "2026-10-27", count: 174 },
			]),
		);
		expect(result.materializedDays.find((day) => day.date === "2026-10-28")?.count).toBe(394);
		const firstCall = fetch.mock.calls[0] as [string, RequestInit] | undefined;
		expect(String(firstCall?.[1]?.body ?? "")).toContain(chunk.since);
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
			throw new ApiError(502, "github_error", "calendar unavailable", null, 502);
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
		expect(result.chunkFailures[0]?.detail?.httpStatus ?? 502).toBe(502);
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
