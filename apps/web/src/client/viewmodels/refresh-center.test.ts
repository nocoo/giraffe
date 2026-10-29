import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefreshPartialReason, RefreshRun } from "../../lib/refresh-types";
import { apiGet } from "../lib/api";
import { defaultRefreshParams } from "./refresh";
import {
	canCancelRefresh,
	formatRefreshDuration,
	mergeRefreshRuns,
	RefreshCenterViewModel,
	type RefreshLiveModel,
	type RefreshLiveState,
	refreshAccountRow,
	refreshCurrentStep,
	refreshDuration,
	refreshDurationLabel,
	refreshFailureText,
	refreshHistoryRows,
	refreshProblemRepos,
	refreshProgressOf,
	refreshReasons,
	refreshRepoRows,
	refreshRequestNote,
	refreshRequestRows,
	refreshScopeLabel,
	refreshStepTiming,
	refreshTimingRows,
	refreshWindowLabel,
} from "./refresh-center";
import { setActiveAccountId } from "./session";

vi.mock("../lib/api", () => ({ apiGet: vi.fn() }));

const NOW = Date.parse("2026-10-29T04:10:00Z");

function run(overrides: Partial<RefreshRun> = {}): RefreshRun {
	return {
		id: "run-1",
		accountId: "account-1",
		params: {
			...defaultRefreshParams(new Date("2026-10-29T04:00:00Z")),
			dimensions: ["commits", "issues", "prs", "actions", "releases", "alerts"],
		},
		trigger: "manual",
		status: "running",
		phase: "repos",
		repos: ["nocoo/app", "nocoo/web"],
		completedRepos: 1,
		requests: 6,
		requestBreakdown: {
			total: 6,
			graphql: 2,
			rest: 4,
			a: { graphql: 1, rest: 0 },
			b: { graphql: 1, rest: 4 },
		},
		partialReasons: [],
		partial: false,
		aReused: false,
		cancelRequested: false,
		errorCode: null,
		createdAt: "2026-10-29T04:00:00Z",
		updatedAt: "2026-10-29T04:08:00Z",
		finishedAt: null,
		...overrides,
	};
}

const reason = (value: Partial<RefreshPartialReason>): RefreshPartialReason => ({
	repo: "nocoo/app",
	codes: [],
	...value,
});

describe("refresh center run summaries", () => {
	it("preserves missing historical diagnostics without claiming complete results", () => {
		const historical = run({ status: "partial", phase: "done", completedRepos: 2 });
		Reflect.deleteProperty(historical, "partialReasons");
		Reflect.deleteProperty(historical, "requestBreakdown");
		Reflect.deleteProperty(historical, "cancelRequested");
		expect(refreshHistoryRows([run(), historical])[1]?.problems).toBe("未记录");
		expect(refreshAccountRow(historical).status).toBe("unknown");
		expect(refreshRepoRows(historical).every((row) => row.status === "unknown")).toBe(true);
		expect(refreshRepoRows(historical)[0]?.dimensions.every((row) => row.state === "unknown")).toBe(
			true,
		);
		expect(refreshProgressOf(historical)).toMatchObject({ processed: 3, complete: 0, unknown: 3 });
		expect(refreshRequestRows(historical)[0]?.total).toBeNull();
	});

	it("bounds unfinished terminal step durations and distinguishes fatal B from untouched repos", () => {
		const terminal = {
			...run({
				status: "failed",
				phase: "done",
				finishedAt: "2026-10-29T04:02:00Z",
				repos: ["nocoo/app", "nocoo/web", "nocoo/untouched"],
				partialReasons: [reason({ repo: "nocoo/web", codes: ["github_unauthorized"] })],
			}),
			timings: {
				queuedAt: "2026-10-29T04:00:00Z",
				a: { startedAt: "2026-10-29T04:00:00Z", finishedAt: null, attempts: 1, reused: false },
				repos: [
					{ repo: "nocoo/web", startedAt: "2026-10-29T04:01:00Z", finishedAt: null, attempts: 1 },
				],
			},
		};
		for (const status of ["failed", "cancelled"] as const) {
			const ended = { ...terminal, status };
			expect(refreshAccountRow(ended, NOW).timing?.durationSeconds).toBe(120);
			expect(refreshAccountRow(ended, NOW + 86400000).timing?.durationSeconds).toBe(120);
			expect(refreshRepoRows(ended, NOW)[1]?.timing?.durationSeconds).toBe(60);
			expect(refreshRepoRows(ended, NOW + 86400000)[1]?.timing?.durationSeconds).toBe(60);
			expect(refreshRepoRows(ended).map((row) => row.status)).toEqual([
				"complete",
				status === "failed" ? "failed" : "interrupted",
				"skipped",
			]);
			expect(refreshProgressOf(ended)).toMatchObject({ processed: 2, complete: 2, partial: 0 });
			Reflect.deleteProperty(ended, "timings");
			expect(refreshRepoRows(ended).map((row) => row.status)).toEqual([
				"complete",
				status === "failed" ? "failed" : "interrupted",
				"skipped",
			]);
		}
	});
	it("labels scope, trigger, window and current step", () => {
		expect(refreshScopeLabel(run())).toBe("手动 · 星标仓库 + 上海当日新建且未观测的非 fork 仓库");
		expect(refreshScopeLabel(run({ trigger: "scheduled" }))).toBe(
			"每日自动 · 星标仓库 + 上海当日新建且未观测的非 fork 仓库",
		);
		expect(refreshScopeLabel(run({ params: { ...run().params, repo: "nocoo/app" } }))).toBe(
			"单仓库 · nocoo/app",
		);
		expect(refreshWindowLabel(run())).toBe("2026-10-28 → 2026-10-28 · Asia/Shanghai");
		expect(refreshCurrentStep(run({ status: "queued" }))).toBe("排队中 · A 账号信息");
		expect(refreshCurrentStep(run({ phase: "account" }))).toBe("A · 账号信息、贡献趋势与仓库清单");
		expect(refreshCurrentStep(run())).toBe("B · nocoo/web · 2 / 2");
		expect(refreshCurrentStep(run({ completedRepos: 2 }))).toBe("B · 仓库 · 3 / 2");
		expect(refreshCurrentStep(run({ phase: "done", status: "partial" }))).toBe(
			"部分完成 · 刷新结束",
		);
		expect(refreshCurrentStep(run({ phase: "account", status: "cancelled" }))).toBe("A 未完成");
		expect(refreshCurrentStep(run({ status: "failed", phase: "done", repos: [] }))).toBe(
			"刷新失败 · 刷新结束",
		);
	});

	it("computes processed, partial and remaining steps without inventing progress", () => {
		expect(refreshProgressOf(run())).toEqual({
			total: 3,
			processed: 2,
			complete: 2,
			partial: 0,
			unknown: 0,
			pending: 1,
			skipped: 0,
			percent: 67,
		});
		expect(
			refreshProgressOf(
				run({ partialReasons: [reason({ codes: ["issues:inventory_incomplete"] })] }),
			),
		).toMatchObject({ processed: 2, complete: 1, partial: 1 });
		expect(
			refreshProgressOf(
				run({
					status: "cancelled",
					phase: "done",
					partialReasons: [reason({ repo: null, codes: ["catalog:incomplete"] })],
				}),
			),
		).toEqual({
			total: 3,
			processed: 2,
			complete: 1,
			partial: 1,
			unknown: 0,
			pending: 0,
			skipped: 1,
			percent: 67,
		});
		expect(
			refreshProgressOf(
				run({
					status: "failed",
					phase: "done",
					repos: [],
					completedRepos: 0,
				}),
			),
		).toMatchObject({ total: 1, processed: 0, skipped: 1, percent: 0 });
		expect(
			refreshProgressOf(
				run({
					status: "completed",
					phase: "done",
					repos: [],
					completedRepos: 0,
				}),
			),
		).toMatchObject({ total: 1, processed: 1 });
	});

	it("derives the A account row and its honest status", () => {
		expect(refreshAccountRow(run())).toMatchObject({ status: "complete", note: null });
		expect(refreshAccountRow(run({ status: "queued", phase: "account", repos: [] }))).toMatchObject(
			{ status: "pending" },
		);
		expect(refreshAccountRow(run({ phase: "account", repos: [] }))).toMatchObject({
			status: "running",
		});
		expect(
			refreshAccountRow(
				run({
					partialReasons: [reason({ repo: null, codes: ["catalog:incomplete"] })],
				}),
			),
		).toMatchObject({ status: "partial" });
		expect(refreshAccountRow(run({ status: "failed", phase: "done", repos: [] }))).toMatchObject({
			status: "failed",
		});
		expect(refreshAccountRow(run({ status: "cancelled", phase: "done", repos: [] }))).toMatchObject(
			{ status: "skipped" },
		);
		expect(refreshAccountRow(run({ aReused: true }))).toMatchObject({
			note: "复用当日账号数据，0 次上游请求",
		});
		const cancelled = {
			...run({ status: "cancelled", phase: "done", repos: [], completedRepos: 0 }),
			timings: {
				queuedAt: "2026-10-29T04:00:00Z",
				a: {
					startedAt: "2026-10-29T04:00:05Z",
					finishedAt: null,
					attempts: 1,
					reused: false,
				},
				repos: [],
			},
		} as RefreshRun;
		expect(refreshAccountRow(cancelled, NOW).status).toBe("interrupted");
		const finishedA = {
			...cancelled,
			timings: {
				queuedAt: "2026-10-29T04:00:00Z",
				a: {
					startedAt: "2026-10-29T04:00:05Z",
					finishedAt: "2026-10-29T04:00:15Z",
					attempts: 1,
					reused: false,
				},
				repos: [],
			},
		} as RefreshRun;
		expect(refreshAccountRow(finishedA, NOW).status).toBe("complete");
		expect(refreshProgressOf(finishedA)).toMatchObject({
			total: 1,
			processed: 1,
			complete: 1,
			skipped: 0,
		});
	});

	it("splits actual A/B requests and degrades when older runs lack the breakdown", () => {
		expect(refreshRequestRows(run())).toEqual([
			{ key: "a", label: "A · 账号", graphql: 1, rest: 0, total: 1 },
			{ key: "b", label: "B · 仓库", graphql: 1, rest: 4, total: 5 },
			{ key: "total", label: "合计", graphql: 2, rest: 4, total: 6 },
		]);
		expect(refreshRequestRows(run({ requestBreakdown: undefined as never }))).toEqual([
			{ key: "a", label: "A · 账号", graphql: null, rest: null, total: null },
			{ key: "b", label: "B · 仓库", graphql: null, rest: null, total: null },
			{ key: "total", label: "合计", graphql: null, rest: null, total: 6 },
		]);
		expect(refreshRequestNote(run())).toBeNull();
		expect(refreshRequestNote(run({ requestBreakdown: undefined as never }))).toContain("共 6 次");
		expect(
			refreshRequestNote(
				run({
					requestBreakdown: {
						total: 6,
						graphql: 2,
						rest: 4,
						a: { graphql: 1, rest: 0 },
						b: undefined as never,
					},
				}),
			),
		).toContain("A/B 拆分");
	});

	it("reports durations from saved timestamps and tolerates missing ones", () => {
		expect(refreshDuration(run(), NOW)).toBe(600);
		expect(formatRefreshDuration(0)).toBe("0 秒");
		expect(formatRefreshDuration(65)).toBe("1 分 5 秒");
		expect(formatRefreshDuration(3725)).toBe("1 小时 2 分钟");
		expect(formatRefreshDuration(null)).toBe("—");
		expect(refreshDurationLabel(run(), NOW)).toBe("10 分 0 秒");
		expect(
			refreshDurationLabel(
				run({ finishedAt: "2026-10-29T04:03:00Z", updatedAt: "2026-10-29T04:03:00Z" }),
				NOW,
			),
		).toBe("3 分 0 秒");
		expect(refreshDuration(run({ createdAt: "not-a-date" }), NOW)).toBeNull();
		expect(
			refreshDuration(
				run({ createdAt: "2026-10-29T05:00:00Z", finishedAt: "2026-10-29T04:00:00Z" }),
				NOW,
			),
		).toBeNull();
		expect(refreshTimingRows(run(), NOW)).toEqual([
			{ label: "开始", value: expect.any(String) },
			{ label: "最后响应", value: expect.any(String) },
			{ label: "耗时", value: "10 分 0 秒" },
		]);
		expect(
			refreshTimingRows(run({ finishedAt: "2026-10-29T04:03:00Z" }), NOW).map((row) => row.label),
		).toEqual(["开始", "最后响应", "结束", "耗时"]);
	});

	it("uses optional per-step timings without inventing them", () => {
		const timed = {
			...run(),
			timings: {
				queuedAt: "2026-10-29T04:00:00Z",
				a: {
					startedAt: "2026-10-29T04:00:05Z",
					finishedAt: "2026-10-29T04:00:15Z",
					attempts: 1,
					reused: false,
				},
				repos: [
					{
						repo: "nocoo/app",
						startedAt: "2026-10-29T04:00:15Z",
						finishedAt: "2026-10-29T04:01:15Z",
						attempts: 2,
					},
					{
						repo: "nocoo/web",
						startedAt: "2026-10-29T04:01:15Z",
						finishedAt: null,
						attempts: 1,
					},
				],
			},
		} as RefreshRun;
		expect(refreshAccountRow(timed, NOW).timing).toEqual({
			startedAt: "2026-10-29T04:00:05Z",
			finishedAt: "2026-10-29T04:00:15Z",
			attempts: 1,
			durationSeconds: 10,
			durationLabel: "10 秒",
			interrupted: false,
		});
		const rows = refreshRepoRows(timed, NOW);
		expect(rows[0]?.timing).toMatchObject({ durationLabel: "1 分 0 秒", attempts: 2 });
		expect(rows[1]?.timing).toMatchObject({
			finishedAt: null,
			interrupted: true,
			durationSeconds: 525,
			durationLabel: "8 分 45 秒",
		});
		expect(refreshTimingRows(timed, NOW).map((row) => row.label)).toEqual([
			"开始",
			"最后响应",
			"A 开始",
			"耗时",
		]);
		expect(refreshAccountRow(run()).timing).toBeNull();
		expect(refreshRepoRows(run())[0]?.timing).toBeNull();
		expect(
			refreshStepTiming({ startedAt: "bad-date", finishedAt: null, attempts: 1 }, NOW),
		).toMatchObject({ durationSeconds: null, durationLabel: "—" });
	});
});

describe("refresh center repositories and reasons", () => {
	it("parses dimension-prefixed codes, failure details and unknown codes", () => {
		const parsed = refreshReasons(
			reason({
				codes: ["issues:inventory_incomplete", "github_error", "repository_cooldown"],
				failures: [
					{
						dimension: "issues",
						code: "inventory_incomplete",
						httpStatus: 200,
						graphqlType: "Repository",
						graphqlPath: ["repository", "issues"],
					},
					{
						dimension: "actions",
						code: "github_error",
						httpStatus: 403,
						graphqlType: null,
						graphqlPath: null,
					},
				],
			}),
		);
		expect(parsed.map((entry) => [entry.dimension, entry.code, entry.label])).toEqual([
			["issues", "inventory_incomplete", "Issues · Issue 清单未完整"],
			[null, "github_error", "GitHub 请求失败"],
			[null, "repository_cooldown", "仓库刷新冷却中"],
			["actions", "github_error", "CI / Actions · 读取失败"],
		]);
		expect(parsed[0]?.failures).toHaveLength(1);
		expect(parsed[0]?.label).not.toContain("403");
		expect(refreshReasons(reason({ codes: ["custom_code"] }))[0]?.label).toBe("custom_code");
		expect(
			refreshReasons(
				reason({
					codes: [],
					failures: [
						{
							dimension: null,
							code: "network_error",
							httpStatus: null,
							graphqlType: null,
							graphqlPath: null,
						},
					],
				}),
			)[0],
		).toMatchObject({ dimension: null, code: "network_error", label: "网络请求失败" });
		expect(refreshReasons(reason({ codes: ["releases"] }))[0]).toMatchObject({
			dimension: "releases",
			code: "partial",
			label: "发布 · partial",
		});
		expect(
			refreshFailureText({
				dimension: "alerts",
				code: "permission_denied",
				httpStatus: 403,
				graphqlType: null,
				graphqlPath: null,
			}),
		).toBe("HTTP 403 · 依赖告警");
		expect(
			refreshFailureText({
				dimension: null,
				code: "network_error",
				httpStatus: null,
				graphqlType: "Query",
				graphqlPath: ["viewer", "repositories"],
			}),
		).toBe("GraphQL Query · viewer.repositories");
		expect(
			refreshFailureText({
				dimension: "custom",
				code: "unknown",
				httpStatus: null,
				graphqlType: null,
				graphqlPath: null,
			}),
		).toBe("custom");
		expect(
			refreshFailureText({
				dimension: null,
				code: "github_error",
				httpStatus: null,
				graphqlType: null,
				graphqlPath: null,
			}),
		).toBe("github_error");
	});

	it("derives per-repository status and per-dimension reasons", () => {
		const rows = refreshRepoRows(
			run({
				partialReasons: [
					reason({
						codes: ["issues:inventory_incomplete"],
						failures: [
							{
								dimension: "issues",
								code: "inventory_incomplete",
								httpStatus: 200,
								graphqlType: null,
								graphqlPath: null,
							},
						],
					}),
				],
			}),
		);
		expect(rows.map((row) => [row.repo, row.status])).toEqual([
			["nocoo/app", "partial"],
			["nocoo/web", "running"],
		]);
		expect(rows[0]?.dimensions.map((entry) => [entry.dimension, entry.state])).toEqual([
			["commits", "complete"],
			["issues", "partial"],
			["prs", "complete"],
			["actions", "complete"],
			["releases", "complete"],
			["alerts", "complete"],
		]);
		expect(rows[0]?.dimensions[1]?.reasons[0]).toMatchObject({
			label: "Issues · Issue 清单未完整",
		});
		expect(rows[1]?.dimensions.every((entry) => entry.state === "running")).toBe(true);
	});

	it("marks collection-level reasons across dimensions and keeps terminal leftovers skipped", () => {
		const rows = refreshRepoRows(
			run({
				status: "cancelled",
				phase: "done",
				partialReasons: [reason({ codes: ["collection:partial"] })],
			}),
		);
		expect(rows[0]?.status).toBe("partial");
		expect(rows[0]?.dimensions.every((entry) => entry.state === "partial")).toBe(true);
		expect(rows[1]?.status).toBe("skipped");
		expect(rows[1]?.dimensions.every((entry) => entry.state === "skipped")).toBe(true);
		expect(refreshRepoRows(run({ status: "queued", phase: "account", completedRepos: 0 }))).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ repo: "nocoo/app", status: "pending" }),
				expect.objectContaining({ repo: "nocoo/web", status: "pending" }),
			]),
		);
		const interrupted = {
			...run({ status: "cancelled", phase: "done", completedRepos: 0 }),
			timings: {
				queuedAt: "2026-10-29T04:00:00Z",
				a: {
					startedAt: "2026-10-29T04:00:05Z",
					finishedAt: "2026-10-29T04:00:15Z",
					attempts: 1,
					reused: false,
				},
				repos: [
					{
						repo: "nocoo/app",
						startedAt: "2026-10-29T04:00:15Z",
						finishedAt: null,
						attempts: 1,
					},
				],
			},
		} as RefreshRun;
		const interruptedRows = refreshRepoRows(interrupted, NOW);
		expect(interruptedRows[0]?.status).toBe("interrupted");
		expect(interruptedRows[0]?.dimensions.every((entry) => entry.state === "interrupted")).toBe(
			true,
		);
		expect(interruptedRows[1]?.status).toBe("skipped");
		expect(
			refreshRepoRows(
				run({
					partialReasons: [
						reason({
							codes: ["github_error"],
						}),
					],
				}),
			)[0]?.dimensions,
		).toEqual(
			expect.arrayContaining([expect.objectContaining({ dimension: "commits", state: "partial" })]),
		);
		expect(
			refreshRepoRows(run({ completedRepos: 2, repos: ["nocoo/app"] }))
				.map((row) => row.status)
				.join(),
		).toBe("complete");
	});

	it("lists problem repositories and cancels only active runs that are not already stopping", () => {
		expect(
			refreshProblemRepos(
				run({
					partialReasons: [
						reason({ repo: null, codes: ["catalog:incomplete"] }),
						reason({ codes: ["issues:inventory_incomplete"] }),
						reason({ codes: ["prs:inventory_incomplete"] }),
					],
				}),
			),
		).toEqual(["账号", "nocoo/app"]);
		expect(refreshProblemRepos(run())).toEqual([]);
		expect(canCancelRefresh(run())).toBe(true);
		expect(canCancelRefresh(run({ cancelRequested: true }))).toBe(false);
		expect(canCancelRefresh(run({ status: "completed", phase: "done" }))).toBe(false);
	});

	it("builds history rows with scope, duration, requests and problems", () => {
		const rows = refreshHistoryRows(
			[
				run({
					id: "run-2",
					status: "partial",
					phase: "done",
					finishedAt: "2026-10-29T04:03:00Z",
					partialReasons: [reason({ codes: ["issues:inventory_incomplete"] })],
				}),
				run({ id: "run-1" }),
			],
			NOW,
		);
		expect(rows[0]).toMatchObject({
			id: "run-2",
			status: "部分完成",
			scope: "手动 · 星标仓库 + 上海当日新建且未观测的非 fork 仓库",
			duration: "3 分 0 秒",
			requests: "6",
			problems: "nocoo/app",
			active: false,
		});
		expect(rows[1]).toMatchObject({ id: "run-1", active: true, problems: "—" });
	});

	it("merges the live run into saved history without duplicating it", () => {
		const saved = [run({ id: "run-2" }), run({ id: "run-1" })];
		expect(mergeRefreshRuns(saved, null)).toBe(saved);
		expect(mergeRefreshRuns(saved, run({ id: "run-1", requests: 99 }))[1]?.requests).toBe(99);
		expect(mergeRefreshRuns(saved, run({ id: "run-3" })).map((entry) => entry.id)).toEqual([
			"run-3",
			"run-2",
			"run-1",
		]);
	});

	it("keeps fresher history evidence over an older live snapshot", () => {
		const saved = run({
			status: "cancelled",
			phase: "done",
			completedRepos: 2,
			requests: 20,
			updatedAt: "2026-10-29T04:09:00Z",
		});
		expect(mergeRefreshRuns([saved], run())[0]).toMatchObject({
			status: "cancelled",
			requests: 20,
		});
	});
});

type FakeLive = {
	getSnapshot: () => RefreshLiveState;
	subscribe: (listener: () => void) => () => void;
	subscribeData: (listener: () => void) => () => void;
	read: ReturnType<typeof vi.fn>;
	start: ReturnType<typeof vi.fn>;
	cancel: ReturnType<typeof vi.fn>;
	set: (next: Partial<RefreshLiveState>) => void;
	notifyData: () => void;
	listenerCount: () => number;
};

function fakeLive(initial: RefreshRun | null, accountId = "account-1"): FakeLive {
	let state = {
		accountId,
		run: initial,
		loading: false,
		reading: false,
		starting: false,
		cancelling: false,
		available: true,
		ready: true,
		error: null,
	} as unknown as RefreshLiveState;
	const listeners = new Set<() => void>();
	const dataListeners = new Set<() => void>();
	return {
		getSnapshot: () => state,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		subscribeData: (listener) => {
			dataListeners.add(listener);
			return () => {
				dataListeners.delete(listener);
			};
		},
		read: vi.fn(async () => undefined),
		start: vi.fn(async () => undefined),
		cancel: vi.fn(async () => undefined),
		set: (next) => {
			state = { ...state, ...next };
			for (const listener of listeners) listener();
		},
		notifyData: () => {
			for (const listener of dataListeners) listener();
		},
		listenerCount: () => listeners.size,
	};
}

const HISTORY = { items: [] as RefreshRun[], collectionAvailable: true };
const models: RefreshCenterViewModel[] = [];

function center(live: FakeLive, now = NOW) {
	const model = new RefreshCenterViewModel(live as unknown as RefreshLiveModel, now);
	models.push(model);
	return model;
}

beforeEach(() => {
	vi.resetAllMocks();
	setActiveAccountId("account-1");
	vi.mocked(apiGet).mockResolvedValue(HISTORY);
});

afterEach(() => {
	for (const model of models.splice(0)) model.dispose();
	setActiveAccountId(null);
});

describe("refresh center viewmodel", () => {
	it("selects and displays the newest saved snapshot of the current run", async () => {
		const saved = run({
			status: "cancelled",
			phase: "done",
			completedRepos: 2,
			requests: 20,
			updatedAt: "2026-10-29T04:09:00Z",
		});
		vi.mocked(apiGet).mockResolvedValue({ items: [saved], collectionAvailable: true });
		const model = center(fakeLive(run()));
		await vi.waitFor(() => expect(model.getSnapshot().loading).toBe(false));
		expect(model.getSnapshot().selected).toMatchObject({ status: "cancelled", requests: 20 });
		expect(model.getSnapshot().live.run).toMatchObject({ status: "cancelled", requests: 20 });
		model.select("run-1");
		expect(model.getSnapshot().selected?.status).toBe("cancelled");
	});

	it("rereads stale live state before starting after a saved terminal snapshot", async () => {
		const saved = run({ status: "cancelled", phase: "done", updatedAt: "2026-10-29T04:09:00Z" });
		vi.mocked(apiGet).mockResolvedValue({ items: [saved], collectionAvailable: true });
		const live = fakeLive(run());
		live.read.mockImplementation(async () => {
			live.set({ run: saved });
		});
		const model = center(live);
		await vi.waitFor(() => expect(model.getSnapshot().loading).toBe(false));
		await model.start(defaultRefreshParams());
		expect(live.read).toHaveBeenCalledOnce();
		expect(live.start).toHaveBeenCalledOnce();
	});
	it("rejects another tab's account history instead of relabeling it", async () => {
		vi.mocked(apiGet).mockImplementation(async (path) =>
			path === "accounts"
				? { accounts: [{ id: "account-1", is_active: true }] }
				: { items: [run({ accountId: "account-2" })], collectionAvailable: true },
		);
		const model = center(fakeLive(run()));
		await vi.waitFor(() => expect(model.getSnapshot().loading).toBe(false));
		expect(model.getSnapshot().history).toEqual([]);
		expect(model.getSnapshot().error).toContain("账号已变化");
		expect(model.getSnapshot().runs.every((entry) => entry.accountId === "account-1")).toBe(true);
	});
	it("loads history once, merges the live run and switches the selected run", async () => {
		const older = run({ id: "run-0", status: "completed", phase: "done" });
		vi.mocked(apiGet).mockResolvedValue({ items: [older], collectionAvailable: true });
		const live = fakeLive(run());
		const model = center(live);
		await vi.waitFor(() => expect(model.getSnapshot().loading).toBe(false));
		expect(apiGet).toHaveBeenCalledWith("refresh-runs");
		expect(model.getSnapshot().runs.map((entry) => entry.id)).toEqual(["run-1", "run-0"]);
		expect(model.getSnapshot()).toMatchObject({
			accountId: "account-1",
			selectedId: "",
			selected: { id: "run-1" },
		});
		model.select("run-0");
		expect(model.getSnapshot()).toMatchObject({
			selectedId: "run-0",
			selected: { id: "run-0", status: "completed" },
		});
		model.select("");
		expect(model.getSnapshot().selected?.id).toBe("run-1");
		model.dispose();
	});

	it("falls back to saved history, resets selection on account switches and reloads on data events", async () => {
		const older = run({ id: "run-0", status: "completed", phase: "done" });
		vi.mocked(apiGet).mockResolvedValue({ items: [older], collectionAvailable: true });
		const live = fakeLive(null);
		const model = center(live);
		expect(model.getSnapshot().selected).toBeNull();
		await vi.waitFor(() => expect(model.getSnapshot().selected?.id).toBe("run-0"));
		model.select("run-0");
		live.set({
			run: run({ status: "completed", phase: "done", finishedAt: "2026-10-29T04:05:00Z" }),
		});
		expect(model.getSnapshot().runs[0]?.status).toBe("completed");
		expect(model.getSnapshot().selectedId).toBe("run-0");
		live.notifyData();
		await vi.waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
		live.set({ accountId: "account-2" });
		expect(model.getSnapshot()).toMatchObject({ selectedId: "", selected: null });
		setActiveAccountId("account-2");
		await vi.waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
		model.dispose();
	});

	it("shows a safe history error, retries, and queues a reload instead of overlapping", async () => {
		vi.mocked(apiGet).mockRejectedValueOnce(new Error("secret"));
		const live = fakeLive(null);
		const model = center(live);
		await vi.waitFor(() => expect(model.getSnapshot().error).toContain("无法读取或启动刷新"));
		expect(model.getSnapshot().error).not.toContain("secret");
		expect(model.getSnapshot().loading).toBe(false);
		let finish: ((body: unknown) => void) | undefined;
		vi.mocked(apiGet)
			.mockResolvedValue({ items: [run({ id: "run-2" })], collectionAvailable: true })
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
		const first = model.load();
		const second = model.load();
		expect(apiGet).toHaveBeenCalledTimes(2);
		finish?.({ items: [run({ id: "run-2" })], collectionAvailable: true });
		await Promise.all([first, second]);
		await vi.waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
		expect(model.getSnapshot().history[0]?.id).toBe("run-2");
		model.dispose();
	});

	it("drops a history response from a superseded account and reloads after it settles", async () => {
		let finish: ((body: unknown) => void) | undefined;
		vi.mocked(apiGet)
			.mockResolvedValue({
				items: [run({ id: "run-2", accountId: "account-2" })],
				collectionAvailable: true,
			})
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
		const live = fakeLive(null);
		const model = center(live);
		setActiveAccountId("account-2");
		live.set({ accountId: "account-2" });
		expect(model.getSnapshot()).toMatchObject({
			history: [],
			historyAccount: null,
			selected: null,
		});
		finish?.({ items: [run({ id: "stale" })], collectionAvailable: true });
		await vi.waitFor(() => expect(model.getSnapshot().history[0]?.id).toBe("run-2"));
		expect(apiGet).toHaveBeenCalledTimes(2);
		expect(model.getSnapshot()).toMatchObject({ loading: false, historyAccount: "account-2" });
		model.dispose();
	});

	it("delegates start, cancel and read while keeping selection on the current run", async () => {
		vi.mocked(apiGet).mockResolvedValue({
			items: [run({ id: "run-0", status: "completed", phase: "done" })],
			collectionAvailable: true,
		});
		const live = fakeLive(run());
		const model = center(live);
		await vi.waitFor(() => expect(model.getSnapshot().loading).toBe(false));
		model.select("run-0");
		await model.start(defaultRefreshParams());
		expect(live.start).toHaveBeenCalledWith(defaultRefreshParams());
		expect(model.getSnapshot().selectedId).toBe("");
		await model.cancel();
		expect(live.cancel).toHaveBeenCalledOnce();
		await model.refreshAll();
		expect(live.read).toHaveBeenCalledOnce();
		expect(apiGet).toHaveBeenCalledTimes(2);
		model.dispose();
	});

	it("ticks only while a refresh is active and stops after disposal", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const live = fakeLive(run());
		const model = center(live, 1000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(model.getSnapshot().now).toBe(NOW + 1000);
		live.set({ run: null });
		const frozen = model.getSnapshot().now;
		await vi.advanceTimersByTimeAsync(1000);
		expect(model.getSnapshot().now).toBe(frozen);
		model.dispose();
		model.dispose();
		live.set({ run: run() });
		expect(model.getSnapshot().now).toBe(frozen);
		expect(live.listenerCount()).toBe(0);
		model.select("run-0");
		expect(model.getSnapshot().selectedId).toBe("");
		await model.load();
		expect(apiGet).toHaveBeenCalledOnce();
		vi.useRealTimers();
	});
});
