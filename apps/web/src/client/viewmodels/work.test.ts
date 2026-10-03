import type { Resource } from "@nocoo/giraffe-agent/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { apiGet, apiPost, apiWrite } from "../lib/api";
import { ApiError } from "../lib/errors";
import { setActiveAccountId } from "./session";
import { loadWork, setWorkPaused, workBoard, workExperience } from "./work";

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
it("presents idle analysis history without inventing execution or leaking tool output", () => {
	const data = {
		account_id: "a",
		cron: row("cron", "work-cron", cron),
		control: null,
		jobs: [
			row("old", "work-run", {
				occurrence: "opaque-private-id",
				updatedAt: at,
				events: [
					"[主控] API 快照：12 个自有仓库，3 条 Issue，2 条 PR",
					"[Jev 优先级] 批次 1/1，12 个仓库",
					"[常驻 issues 会话 3] safe：bun run secret",
					"<script>alert(1)</script>",
					"[主控调度] malicious\nrm -rf /Users/private",
				],
				repositories: {},
			}),
		],
	};
	const experience = workExperience(data, Date.parse(at), null);
	expect(experience.selected).toMatchObject({
		id: "old",
		current: false,
		status: "已完成",
		empty: "本周期没有可执行仓库，分析记录仍可查看。",
	});
	expect(experience.nodes.every((node) => node.state !== "进行中")).toBe(true);
	expect(experience.selected?.activities.map((item) => item.category)).toEqual([
		"观察",
		"决策",
		"分析",
		"调度",
	]);
	expect(experience.selected?.omittedEvents).toBe(1);
	expect(JSON.stringify(experience)).not.toMatch(/bun run|rm -rf|script|opaque-private-id|\/Users/);
});
it("keeps a selected historical run when polling adds a new current run", () => {
	const old = row("old", "work-run", { occurrence: "old-occurrence", updatedAt: at, events: [] });
	const newer = {
		...row("new", "work-run", { occurrence: "new-occurrence", updatedAt: at, events: [] }),
		status: "running",
		created_at: "2026-10-03T01:00:00Z",
	};
	const data = {
		account_id: "a",
		jobs: [old, newer],
		cron: row("cron", "work-cron", {
			...cron,
			state: "running",
			activeOccurrence: "new-occurrence",
		}),
		control: null,
	};
	expect(workExperience(data, Date.parse(at), "old").selected?.id).toBe("old");
	expect(workExperience(data, Date.parse(at), "old").selected?.current).toBe(false);
	expect(workExperience(data, Date.parse(at), null).selected).toMatchObject({
		id: "new",
		current: true,
		status: "进行中",
	});
	expect(workExperience(data, Date.parse(at) + 50000, "new").selected?.status).toBe(
		"执行状态待确认",
	);
});
it("projects every repository phase, task outcome and model without untrusted prose", () => {
	const statuses = [
		"preparing",
		"fixing",
		"checking",
		"reviewing",
		"signed_off",
		"locally_reviewed",
		"reviewed_no_change",
		"pushed",
		"deferred",
		"exhausted",
		"blocked",
		"unknown",
	];
	for (const status of statuses) {
		for (const outcome of [undefined, "pending", "passed", "failed", "timeout"] as const) {
			const data = {
				account_id: "a",
				cron: row("cron", "work-cron", { ...cron, state: "running", activeOccurrence: "one" }),
				control: null,
				jobs: [
					{
						...row("run", "work-run", {
							occurrence: "one",
							updatedAt: at,
							events: ["[独立审查 3] dangerous"],
							repositories: {
								"owner/repo": {
									tasks: ["dependency:1", "pr:2", "ci:37090299284"],
									worker: 1,
									reviewer: 2,
									workerModel: "gpt-6-astra / off",
									reviewerModel: "gpt-6-sol / high",
									round: 20,
									findings: ["rm -rf /private"],
									head: "secret",
									status,
									dispositions: [
										{ task: "dependency:1", outcome: "committed", reason: "bun run hidden" },
									],
									detailsOmitted: true,
									dispositionOutcomes: "CND",
									...(outcome ? { followup: { checks: 1, outcome } } : {}),
								},
								"<img src=x>": {
									tasks: [],
									compactTasks: "d4,p5,c6",
									worker: null,
									reviewer: null,
									round: 0,
									findings: [],
									head: null,
									status: "unknown",
									workerModel: "bun run malicious",
									reviewerModel: "<html>",
								},
							},
						}),
						status: "running",
					},
				],
			};
			const board = workExperience(data, Date.parse(at), null);
			const repo = board.selected?.repositories[0];
			expect(repo?.tasks.map((task) => task.label)).toEqual([
				"依赖升级 #1",
				"清理 PR #2",
				"CI 故障 #37090299284",
			]);
			expect(repo?.tasks.map((task) => task.outcome)).toEqual(["已提交", "审查后无需改动", "暂缓"]);
			expect(repo?.workerModel).toBe("gpt-6-astra / off");
			expect(repo?.phase).toBe(
				outcome ? 4 : statuses.indexOf(status) < 3 ? (status === "preparing" ? 0 : 1) : repo?.phase,
			);
			expect(board.selected?.repositories[1]).toMatchObject({
				name: "仓库名称未验证",
				workerModel: "模型未上报",
				reviewerModel: "模型未上报",
			});
			expect(JSON.stringify(board)).not.toMatch(/rm -rf|bun run|<img|<html>|secret/);
		}
	}
});
it("allowlists all producer activity categories and preserves repeated events", () => {
	const prefixes = [
		"[主控] API 快照：bad",
		"[主控] 本周期无可执行仓库",
		"[Jev 优先级]",
		"[会话 1]",
		"[候选]",
		"[主控调度]",
		"[准备交接 1]",
		"[Worker 交接 2]",
		"[独立审查 3]",
		"[仓库进度]",
		"[任务终态]",
		"[本地完成]",
		"[发布恢复完成]",
		"[主控发布]",
		"[Issue 已关闭]",
		"[推送跟进]",
		"[工作区阻塞]",
		"[仓库阻塞]",
		"[修复周期失败]",
		"[分析关注]",
		"[分析证据缺失]",
		"[常驻 issues 失败]",
		"[常驻 prs 会话 2]",
		"[常驻 ci 会话 3]",
		"[常驻 cd 会话 4]",
		"[会话 1]",
	];
	const data = {
		account_id: "a",
		cron: row("cron", "work-cron", { ...cron, activeOccurrence: "one" }),
		control: null,
		jobs: [
			{
				...row("run", "work-run", {
					occurrence: "one",
					updatedAt: at,
					events: prefixes.map((prefix) => `${prefix} rm -rf /hidden`),
				}),
				status: "running",
			},
		],
	};
	const board = workExperience(data, Date.parse(at), null);
	expect(board.selected?.activities).toHaveLength(prefixes.length);
	expect(board.nodes.find((node) => node.id === "coordinator")?.state).toBe("有活动记录");
	expect(JSON.stringify(board)).not.toContain("rm -rf");
});
it("distinguishes missing, offline, paused, error and malformed controls", () => {
	const data = { account_id: "a", jobs: [], cron: null, control: null };
	expect(workExperience(data, 0, null)).toMatchObject({
		selected: null,
		runtime: "本机离线",
		canPause: false,
	});
	for (const state of ["idle", "offline", "error", "running"]) {
		const board = workExperience(
			{
				...data,
				cron: row("cron", "work-cron", {
					...cron,
					state,
					paused: true,
					lastError: "bash /private",
				}),
				control: row("bad", "wrong", { paused: "bad" }),
			},
			Date.parse(at),
			null,
		);
		expect(board.canPause).toBe(false);
		expect(board.errors).toEqual(["本机上报异常，请检查运行状态"]);
	}
	for (const status of ["attention", "blocked", "failed", "unknown", "running"]) {
		const board = workExperience(
			{
				...data,
				jobs: [
					{ ...row("run", "work-run", { occurrence: "one", updatedAt: at, events: [] }), status },
				],
			},
			0,
			"missing",
		);
		expect(board.selected?.status).not.toBe("进行中");
	}
});
it("handles pending tasks, absent models, malformed expanded tasks and past active occurrences", () => {
	const data = {
		account_id: "a",
		cron: row("work-cron", "work-cron", { ...cron, state: "running", activeOccurrence: "other" }),
		control: row("work-control", "work-control", { paused: false }),
		jobs: [
			{
				...row("run", "work-run", {
					occurrence: "one",
					updatedAt: at,
					events: [],
					repositories: {
						"o/r": {
							tasks: [],
							compactTasks: "d99999999999999999",
							worker: null,
							reviewer: null,
							round: 0,
							findings: [],
							head: null,
							status: "reviewing",
						},
					},
				}),
				status: "running",
			},
		],
	};
	expect(workExperience(data, Date.parse(at), "run").selected).toMatchObject({
		current: false,
		repositories: [
			{ tasks: [{ label: "任务详情未上报", outcome: "待处理" }], workerModel: "模型未上报" },
		],
	});
	expect(workExperience(data, Date.parse(at), "run").canPause).toBe(true);
});
it("classifies deferred evidence and findings but keeps successful reasons neutral", () => {
	const reasons = [
		"version upgrade",
		"dirty existing changes",
		"test failed",
		"review finding",
		"source evidence",
		"network connection",
		"unclassified secret",
	];
	const categories = [
		"版本升级需确认",
		"工作区已有改动",
		"检查未通过",
		"审查待修正",
		"来源不足",
		"连接待恢复",
		"需人工查看",
	];
	const data = {
		account_id: "a",
		cron: row("work-cron", "work-cron", { ...cron, state: "error" }),
		control: row("work-control", "work-control", { paused: true }),
		jobs: [
			row("run", "work-run", {
				occurrence: "one",
				updatedAt: at,
				events: ["[常驻 issues 失败] raw"],
				repositories: {
					"o/r": {
						tasks: reasons.map((_, index) => `dependency:${index + 1}`).concat(["pr:8", "pr:9"]),
						worker: 1,
						reviewer: 2,
						round: 0,
						findings: reasons,
						head: null,
						status: "deferred",
						dispositions: reasons
							.map((reason, index) => ({
								task: `dependency:${index + 1}`,
								outcome: "deferred",
								reason,
							}))
							.concat([
								{ task: "pr:8", outcome: "reviewed_no_change", reason: "all checks passed" },
								{ task: "pr:9", outcome: "committed", reason: "all checks passed" },
							]),
					},
				},
			}),
		],
	};
	const board = workExperience(data, Date.parse(at), null);
	expect(board.runtime).toBe("运行异常");
	expect(board.canPause).toBe(true);
	expect(board.analysts[0]?.state).toBe("需关注");
	expect(board.selected?.repositories[0]?.findingCategories).toEqual(categories);
	expect(board.selected?.repositories[0]?.tasks.slice(0, 7).map((task) => task.reason)).toEqual(
		categories,
	);
	expect(board.selected?.repositories[0]?.tasks[7]?.reason).toBe("无需改动说明已记录");
	expect(board.selected?.repositories[0]?.tasks[8]?.reason).toBe("提交说明已记录");
	expect(
		workExperience(
			{ ...data, cron: row("work-cron", "work-cron", { ...cron, paused: true }) },
			Date.parse(at),
			null,
		).runtime,
	).toBe("调度已暂停");
});
it("does not promote a completed analyst event into live execution", () => {
	const board = workExperience(
		{
			account_id: "a",
			cron: row("work-cron", "work-cron", { ...cron, state: "running", activeOccurrence: "one" }),
			control: null,
			jobs: [
				{
					...row("run", "work-run", {
						occurrence: "one",
						updatedAt: at,
						events: ["[常驻 cd 会话 2] done"],
					}),
					status: "running",
				},
			],
		},
		Date.parse(at),
		null,
	);
	expect(board.runtime).toBe("本机在线 · 执行中");
	expect(board.selected?.empty).toContain("尚未选择执行仓库");
	expect(board.nodes.find((node) => node.id === "analysts")?.state).toBe("有活动记录");
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
	expect(workBoard(data, Date.parse(at))).toMatchObject({
		online: true,
		desiredPaused: true,
		pausePending: true,
	});
	expect(workBoard(data, Date.parse(at) + 45001).online).toBe(false);
	expect(workBoard({ ...data, cron: null, control: null }, 0).desiredPaused).toBe(false);
	expect(
		workBoard({ ...data, jobs: [row("bad", "work-run", {})], cron: row("bad", "work-cron", {}) }, 0)
			.errors,
	).toHaveLength(2);
	expect(
		workBoard({ ...data, jobs: [{ ...(data.jobs[0] as Resource), account_id: "other" }] }, 0)
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
	const data = await loadWork();
	expect(data.jobs).toEqual([]);
	vi.mocked(apiWrite).mockResolvedValue({
		account_id: "a",
		item: row("work-control", "work-control", { paused: true }),
	});
	await setWorkPaused("a", data.control, true);
	expect(apiWrite).toHaveBeenCalledWith("agent/accounts/a/records/work-control", "PATCH", {
		revision: 1,
		status: "paused",
		payload: { paused: true },
	});
	vi.mocked(apiPost).mockResolvedValue({
		account_id: "a",
		item: row("work-control", "work-control", { paused: false }),
	});
	await setWorkPaused("a", null, false);
	await expect(setWorkPaused("other", null, false)).rejects.toThrow("Account changed");
	vi.mocked(apiPost).mockResolvedValue({ account_id: "other" });
	await expect(setWorkPaused("a", null, false)).rejects.toThrow("Account changed");
	vi.mocked(apiPost).mockResolvedValue({
		account_id: "a",
		item: { ...row("work-control", "work-control", { paused: false }), account_id: "other" },
	});
	await expect(setWorkPaused("a", null, false)).rejects.toThrow("Account changed");
	vi.mocked(apiPost).mockImplementation(async () => {
		setActiveAccountId("other");
		return { account_id: "a", item: row("work-control", "work-control", { paused: false }) };
	});
	await expect(setWorkPaused("a", null, false)).rejects.toThrow("Account changed");
	setActiveAccountId("a");
	await expect(
		setWorkPaused(
			"a",
			{ ...row("work-control", "work-control", { paused: false }), account_id: "other" },
			false,
		),
	).rejects.toThrow("Account changed");
});
it("preserves missing and failed evidence and rejects pagination/account changes", async () => {
	const accounts = { accounts: [{ id: "a", is_active: true }] };
	vi.mocked(apiGet).mockImplementation(async (path) => {
		if (path === "accounts") return accounts;
		if (path.includes("/records/")) throw new ApiError(404, "not_found", "missing");
		return { account_id: "a", items: [], nextCursor: "same" };
	});
	await expect(loadWork()).rejects.toThrow("pagination");
	vi.mocked(apiGet).mockImplementation(async (path) =>
		path === "accounts"
			? accounts
			: { account_id: "other", item: row("bad", "bad", {}), items: [], nextCursor: null },
	);
	await expect(loadWork()).rejects.toThrow("Account changed");
	vi.mocked(apiGet).mockImplementation(async (path) => {
		if (path === "accounts") return accounts;
		throw new Error("offline");
	});
	await expect(loadWork()).rejects.toThrow("offline");
});
