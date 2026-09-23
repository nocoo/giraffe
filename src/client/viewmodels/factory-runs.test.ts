import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { factoryFixture } from "../../../tests/fixtures/factory-snapshot";
import { type FactoryRunResponse, makeRun, runProgress } from "../../lib/factory-run";
import { apiGet, apiPost } from "../lib/api";
import {
	controlFactoryRun,
	createRunPolling,
	describeRunIssue,
	factoryDataHealth,
	formatRunDuration,
	loadFactoryRuns,
	publicationKey,
	publishedReadNeeded,
	runIssues,
	runRepositoryRows,
	runStages,
	secondsUntil,
	startFactoryRun,
	stepLabel,
} from "./factory-runs";
import { setActiveAccountId } from "./session";

vi.mock("../lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
const snap = factoryFixture();
const run = makeRun("r", snap.account_id, "nocoo", "key", "refresh", snap.repos, snap.fetched_at);

it("shows only repository statistics, details and publication for a scoped run", () => {
	const scoped = makeRun(
		"scoped",
		snap.account_id,
		"nocoo",
		"key",
		"refresh",
		snap.repos,
		snap.fetched_at,
		[],
		["nocoo/app", "org/other"],
		{ scope: "selected" },
	);
	const view = { ...scoped, leaseUntil: null, progress: runProgress(scoped, snap.fetched_at) };
	expect(runStages(view).map((stage) => [stage.title, stage.total])).toEqual([
		["工厂统计", 9],
		["仓库页面", 9],
		["更新页面", 1],
	]);
	expect(runRepositoryRows(view, []).map((row) => row.repo)).toEqual(["nocoo/app"]);
});
const state: FactoryRunResponse = {
	account_id: snap.account_id,
	serverNow: snap.fetched_at,
	current: { ...run, leaseUntil: null, progress: runProgress(run, snap.fetched_at) },
	history: [],
	repositories: [],
	catalog: snap.repos,
	catalogUpdatedAt: snap.fetched_at,
	catalogComplete: true,
	nextAllowedAt: null,
	publication: null,
};
beforeEach(() => {
	setActiveAccountId(snap.account_id);
	vi.mocked(apiGet).mockImplementation(async (path) =>
		path === "accounts" ? { accounts: [{ id: snap.account_id, is_active: true }] } : state,
	);
	vi.mocked(apiPost).mockResolvedValue({ account_id: snap.account_id, id: "r" });
});
afterEach(() => {
	vi.clearAllMocks();
	vi.useRealTimers();
	setActiveAccountId(null);
});
it("loads server state independently of the snapshot and rejects stale-account responses", async () => {
	expect(await loadFactoryRuns()).toEqual(state);
	await startFactoryRun({ mode: "refresh", scope: "selected", repos: ["nocoo/app"] }, "key");
	expect(apiPost).toHaveBeenCalledWith("factory/runs", {
		account_id: snap.account_id,
		requestKey: "key",
		mode: "refresh",
		scope: "selected",
		repos: ["nocoo/app"],
	});
	await controlFactoryRun("r", "pause");
	expect(apiPost).toHaveBeenLastCalledWith("factory/runs/r/control", {
		account_id: snap.account_id,
		action: "pause",
	});
	vi.mocked(apiPost).mockResolvedValue({ account_id: "other" });
	expect(await controlFactoryRun("r", "resume")).toBeNull();
	vi.mocked(apiGet).mockImplementation(async (path) =>
		path === "accounts"
			? { accounts: [{ id: snap.account_id, is_active: true }] }
			: { ...state, account_id: "other" },
	);
	expect(await loadFactoryRuns()).toBeNull();
});
it("serializes polling, slows hidden/idle pages and backs off errors without clearing data", async () => {
	vi.useFakeTimers();
	const receive = vi.fn(),
		error = vi.fn();
	let hidden = false;
	const load = vi.fn().mockResolvedValue(state);
	const poll = createRunPolling({ load, onData: receive, onError: error, hidden: () => hidden });
	await vi.advanceTimersByTimeAsync(0);
	expect(load).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(4999);
	expect(load).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(load).toHaveBeenCalledTimes(2);
	hidden = true;
	await poll.refresh();
	await vi.advanceTimersByTimeAsync(59000);
	expect(load).toHaveBeenCalledTimes(3);
	await vi.advanceTimersByTimeAsync(1000);
	expect(load).toHaveBeenCalledTimes(4);
	load.mockRejectedValueOnce(new Error("offline"));
	await poll.refresh();
	expect(error).toHaveBeenCalledTimes(1);
	expect(receive).toHaveBeenCalledTimes(4);
	poll.stop();
	await vi.advanceTimersByTimeAsync(120000);
	expect(load).toHaveBeenCalledTimes(5);
});
it("reports only actual step completion and server-clock cooldowns", () => {
	expect(secondsUntil("2026-09-15T22:00:30Z", Date.parse(snap.fetched_at))).toBe(30);
	expect(secondsUntil(null, Date.now())).toBe(0);
	expect(secondsUntil("2000-01-01", Date.now())).toBe(0);
	expect(runRepositoryRows(state.current, state.repositories)[0]).toMatchObject({
		repo: "nocoo/app",
		completed: 0,
		total: 18,
		status: "pending",
	});
	expect(runRepositoryRows(null, [])).toEqual([]);
});

it("coalesces overlapping reads, stops late responses and uses idle/error retry delays", async () => {
	vi.useFakeTimers();
	let resolve: (state: FactoryRunResponse | null) => void = () => {};
	const load = vi.fn(
		() =>
			new Promise<FactoryRunResponse | null>((done) => {
				resolve = done;
			}),
	);
	const receive = vi.fn(),
		error = vi.fn();
	const poll = createRunPolling({ load, onData: receive, onError: error, hidden: () => false });
	const first = poll.refresh();
	expect(poll.refresh()).toBe(first);
	resolve({ ...state, current: null });
	await first;
	await vi.advanceTimersByTimeAsync(29999);
	expect(load).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(load).toHaveBeenCalledTimes(2);
	resolve(null);
	await vi.advanceTimersByTimeAsync(0);
	const late = poll.refresh();
	poll.stop();
	resolve(state);
	await late;
	expect(receive).toHaveBeenCalledTimes(1);
	await poll.refresh();
	expect(load).toHaveBeenCalledTimes(3);
	const failed = vi.fn().mockRejectedValue(new Error("offline"));
	const retry = createRunPolling({
		load: failed,
		onData: receive,
		onError: error,
		hidden: () => false,
	});
	await vi.advanceTimersByTimeAsync(0);
	await vi.advanceTimersByTimeAsync(10000);
	expect(failed).toHaveBeenCalledTimes(2);
	retry.stop();
});
it("derives repository outcome from persisted steps, retaining last success timestamps", () => {
	const view = structuredClone(state.current);
	if (!view) throw new Error("fixture");
	const steps = view.steps.filter((s) => s.repo);
	for (const status of ["running", "failed", "skipped", "success"] as const) {
		for (const step of steps) {
			step.status = status;
			step.pages = 1;
			step.durationMs = 1000;
		}
		const rows = runRepositoryRows(view, [
			{
				repo: "nocoo/app",
				refreshedAt: snap.fetched_at,
				status: "success",
				nextAllowedAt: snap.fetched_at,
			},
		]);
		expect(rows[0]?.status).toBe(status);
		expect(rows[0]?.durationMs).toBe(18000);
		expect(rows[0]?.state?.refreshedAt).toBe(snap.fetched_at);
	}
});
it("does not accept responses after the active account changes", async () => {
	vi.mocked(apiPost).mockImplementationOnce(async () => {
		setActiveAccountId("other");
		return { account_id: snap.account_id };
	});
	expect(await startFactoryRun({ mode: "catalog", scope: "all" }, "key")).toBeNull();
	setActiveAccountId(snap.account_id);
	vi.mocked(apiGet).mockImplementation(async (path) => {
		if (path === "accounts") return { accounts: [{ id: snap.account_id, is_active: true }] };
		setActiveAccountId("other");
		return state;
	});
	expect(await loadFactoryRuns()).toBeNull();
});

it("ignores an error arriving after the view has unmounted", async () => {
	let reject: (error: Error) => void = () => {};
	const onError = vi.fn();
	const poll = createRunPolling({
		load: () =>
			new Promise((_resolve, fail) => {
				reject = fail;
			}),
		onData: vi.fn(),
		onError,
		hidden: () => false,
	});
	const pending = poll.refresh();
	poll.stop();
	reject(new Error("late failure"));
	await pending;
	expect(onError).not.toHaveBeenCalled();
});

it("requests a specific run history without performing a mutation", async () => {
	expect(await loadFactoryRuns("run-1")).toEqual(state);
	expect(apiGet).toHaveBeenCalledWith("factory/runs?history=run-1");
	expect(apiPost).not.toHaveBeenCalled();
});

it("separates a finished refresh from missing data and groups the same problem across repositories", () => {
	const snapshot = factoryFixture();
	snapshot.status = "complete";
	snapshot.contributionStatus = "complete";
	const repo = snapshot.repos[0];
	if (!repo) throw new Error("fixture repository missing");
	for (const coverage of Object.values(repo.coverage)) coverage.status = "complete";
	repo.coverage.alerts.status = "unavailable";
	snapshot.repos.push({ ...structuredClone(repo), id: "R_2", name: "nocoo/tools" });
	const completed = makeRun(
		"partial",
		snapshot.account_id,
		"nocoo",
		"k",
		"refresh",
		snapshot.repos,
		snapshot.fetched_at,
	);
	for (const step of completed.steps) {
		step.status = step.kind === "alerts" ? "failed" : "success";
		step.error = step.kind === "alerts" ? "coverage_unavailable" : null;
	}
	completed.status = "partial";
	completed.cursor = completed.steps.length;
	const view = {
		...completed,
		leaseUntil: null,
		progress: runProgress(completed, snapshot.fetched_at),
	};
	expect(view.progress.completed).toBe(view.progress.total);
	expect(runRepositoryRows(view, [])[0]).toMatchObject({ label: "部分数据未获取" });
	expect(runStages(view).map((stage) => [stage.title, stage.completed, stage.total])).toEqual([
		["账号贡献", 1, 1],
		["工厂统计", 18, 18],
		["全站页面", 23, 23],
		["更新页面", 1, 1],
	]);
	const problems = runIssues(view);
	expect(problems).toHaveLength(1);
	expect(problems[0]).toMatchObject({
		kind: "alerts",
		repos: ["nocoo/app", "nocoo/tools"],
		count: 2,
	});
	expect(problems[0]?.title).toContain("安全告警");
	expect(problems[0]?.action).toContain("security_events");
	expect(problems[0]?.impact).toContain("漏洞");
	expect(factoryDataHealth(snapshot)).toMatchObject({
		tone: "info",
		title: "工厂数据可用",
	});
	expect(factoryDataHealth(snapshot).detail).toContain("可选安全告警未获取（2 个仓库）");
	expect(factoryDataHealth(snapshot).detail).toContain("安全状态未知");
	snapshot.publication = { mixed: true, runId: "partial", publishedAt: snapshot.fetched_at };
	expect(factoryDataHealth(snapshot).detail).toContain("更新时间不同");
	repo.coverage.commits.status = "unavailable";
	expect(factoryDataHealth(snapshot)).toMatchObject({
		tone: "warning",
		title: "1 个仓库有数据未获取",
	});
	expect(factoryDataHealth(snapshot).detail).toContain("代码提交（1）");
	expect(factoryDataHealth(snapshot).detail).not.toContain("安全告警");
});

it("explains recovery without treating rate limits, skipped steps or a paused run as lost data", () => {
	const view = structuredClone(state.current);
	const contribution = view?.steps[0];
	const metadata = view?.steps[1];
	if (!view || !contribution || !metadata) throw new Error("fixture steps missing");
	view.status = "paused";
	contribution.error = "github_unauthorized";
	expect(runIssues(view)[0]).toMatchObject({ settings: true });
	expect(describeRunIssue("github_unauthorized", "contributions").action).toContain("继续刷新");
	expect(describeRunIssue("github_rate_limited", "commits").action).toContain("自动继续");
	expect(describeRunIssue("coverage_limited", "commits").impact).toContain("不完整");
	expect(describeRunIssue("repository_cooldown", "metadata").action).toContain("15 分钟");
	expect(describeRunIssue("repository_cooldown", "metadata").impact).toContain("页面数据仍会更新");
	expect(describeRunIssue(null, "publish").impact).toContain("工厂总览");
	contribution.error = null;
	metadata.status = "skipped";
	metadata.error = "repository_failed";
	expect(runIssues(view)).toEqual([]);
	expect(runIssues(null)).toEqual([]);
	view.status = "cancelled";
	expect(runRepositoryRows(view, [])[0]?.label).toBe("未执行完");
	expect(describeRunIssue("future_error", "publish").action).toContain("重试");
});

it("reports missing inventory, healthy data and mixed update times in one health summary", () => {
	expect(factoryDataHealth(null).title).toBe("还没有工厂数据");
	const snapshot = factoryFixture();
	snapshot.inventory.complete = false;
	expect(
		factoryDataHealth({ ...snapshot, inventory: { ...snapshot.inventory, complete: true } }).detail,
	).toContain("等 6 类数据");
	expect(factoryDataHealth(snapshot).title).toBe("仓库列表尚未获取完整");
	snapshot.inventory.complete = true;
	snapshot.status = "complete";
	for (const repo of snapshot.repos)
		for (const coverage of Object.values(repo.coverage)) coverage.status = "complete";
	expect(factoryDataHealth(snapshot).title).toBe("账号贡献日历尚未更新");
	snapshot.contributionStatus = "complete";
	expect(factoryDataHealth(snapshot).tone).toBe("success");
	snapshot.publication = { mixed: true, runId: "mixed", publishedAt: snapshot.fetched_at };
	expect(factoryDataHealth(snapshot).title).toBe("数据可用，更新时间不一致");
	const discovery = makeRun(
		"catalog",
		snapshot.account_id,
		"nocoo",
		"k",
		"catalog",
		[],
		snapshot.fetched_at,
	);
	expect(
		runStages({
			...discovery,
			leaseUntil: null,
			progress: runProgress(discovery, snapshot.fetched_at),
		}).map((stage) => stage.total),
	).toEqual([2, 1, 1]);
});

it("names page steps, explains incomplete page data, and includes non-metric repositories in progress", () => {
	const plan = makeRun(
		"site",
		snap.account_id,
		"nocoo",
		"k",
		"refresh",
		snap.repos,
		snap.fetched_at,
		[],
		["nocoo/app", "org/fork"],
	);
	const traffic = plan.steps.find((s) => s.resource === "repo:org/fork:traffic");
	if (!traffic) throw new Error("missing step");
	traffic.status = "failed";
	traffic.error = "snapshot_unavailable";
	const view = { ...plan, leaseUntil: null, progress: runProgress(plan, snap.fetched_at) };
	expect(stepLabel(traffic)).toContain("流量");
	expect(stepLabel({ kind: "snapshot", resource: "notifications" })).toContain("通知");
	expect(runRepositoryRows(view, []).map((r) => r.repo)).toContain("org/fork");
	expect(runStages(view).reduce((n, s) => n + s.total, 0)).toBe(plan.steps.length);
	expect(runIssues(view)[0]).toMatchObject({ settings: true });
	expect(runIssues(view)[0]?.title).toContain("流量");
	expect(describeRunIssue("snapshot_incomplete", "snapshot", "alerts").impact).toContain("上次");
	expect(describeRunIssue("catalog_changed", "snapshot").action).toContain("同步仓库列表");
});

it("shows actionable distinctions for credential, capacity, access and upstream failures", () => {
	for (const code of ["github_unauthorized", "account_missing"]) {
		expect(describeRunIssue(code, "metadata")).toMatchObject({ settings: true });
		expect(describeRunIssue(code, "metadata").impact).toContain("保留");
	}
	expect(describeRunIssue("encryption_key_missing", "metadata")).toMatchObject({ settings: false });
	expect(describeRunIssue("encryption_key_missing", "metadata").action).toContain("维护者");
	expect(describeRunIssue("factory_capacity", "metadata").action).toContain("减少统计仓库");
	expect(describeRunIssue("factory_capacity", "snapshot").action).toContain("全站清单");
	expect(describeRunIssue("coverage_regression_retained", "commit").impact).toContain("上次的数据");
	for (const code of [
		"coverage_unavailable",
		"github_forbidden",
		"not_found",
		"repository_unavailable",
	]) {
		expect(describeRunIssue(code, "dependencies").reason).toContain("可能");
		expect(describeRunIssue(code, "dependencies").action).toContain("检查来源文件");
	}
	for (const code of ["coverage_limited", "github_response_too_large"]) {
		expect(describeRunIssue(code, "prs").action).toContain("重复刷新不会补齐");
		expect(describeRunIssue(code, "prs").impact).toContain("交付趋势");
	}
	for (const code of ["repository_failed", "run_failed"]) {
		expect(describeRunIssue(code, "commit").action).toContain("先处理前面");
	}
});

it("groups a cooldown once per repository and distinguishes stopped work from queued work", () => {
	const cooled = makeRun(
		"cooled",
		snap.account_id,
		"nocoo",
		"key",
		"refresh",
		snap.repos,
		snap.fetched_at,
		[
			{
				repo: "nocoo/app",
				status: "success",
				refreshedAt: snap.fetched_at,
				nextAllowedAt: "2026-09-16T00:00:00.000Z",
			},
		],
	);
	const view = { ...cooled, leaseUntil: null, progress: runProgress(cooled, snap.fetched_at) };
	expect(runRepositoryRows(view, [])[0]?.label).toBe("等待执行");
	expect(
		view.steps
			.filter((step) => step.kind === "snapshot")
			.every((step) => step.status === "pending"),
	).toBe(true);
	expect(runIssues(view)).toMatchObject([{ kind: "metadata", repos: ["nocoo/app"], count: 9 }]);
	for (const step of view.steps) if (step.kind === "snapshot") step.status = "success";
	expect(runRepositoryRows(view, [])[0]).toMatchObject({
		status: "skipped",
		label: "页面已更新，统计沿用旧数据",
	});
	for (const step of view.steps) if (step.kind === "snapshot") step.status = "pending";
	const metadata = view.steps.find((step) => step.kind === "metadata");
	if (!metadata) throw new Error("fixture metadata missing");
	metadata.status = "pending";
	metadata.startedAt = snap.fetched_at;
	metadata.finishedAt = null;
	metadata.error = null;
	view.status = "paused";
	expect(runRepositoryRows(view, [])[0]?.label).toBe("已暂停");
	metadata.status = "failed";
	expect(
		runIssues(view).some((issue) => issue.code === null && issue.reason.includes("无法确定")),
	).toBe(true);
	view.steps = [];
	expect(runRepositoryRows(view, [])[0]).toMatchObject({ status: "pending", completed: 0 });
});

it("does not label partially cancelled repository work as a successful refresh", () => {
	const view = structuredClone(state.current);
	if (!view) throw new Error("fixture");
	view.status = "cancelled";
	for (const step of view.steps) {
		step.status = step.kind === "metadata" ? "success" : "skipped";
		step.error = step.status === "skipped" ? "cancelled" : null;
	}
	expect(runRepositoryRows(view, [])[0]).toMatchObject({ status: "skipped", label: "未执行完" });
	for (const step of view.steps) {
		step.status = "success";
		step.error = null;
	}
	expect(runRepositoryRows(view, [])[0]).toMatchObject({ status: "success", label: "刷新完成" });
});

it("formats waits without rounding an hour into sixty extra minutes", () => {
	expect([0, 59, 60, 3599, 3600, 3661].map(formatRunDuration)).toEqual([
		"0 秒",
		"59 秒",
		"1 分 0 秒",
		"59 分 59 秒",
		"1 小时 0 分钟",
		"1 小时 1 分钟",
	]);
});

it("reads the published snapshot only when the shown one is not the current publication", () => {
	const shown = factoryFixture();
	shown.publication = { mixed: false, runId: "pub-1", publishedAt: shown.fetched_at };
	const same = { account_id: shown.account_id, publication: "pub-1" };
	expect(publishedReadNeeded(undefined, same, shown)).toBe(false);
	expect(publishedReadNeeded(undefined, { ...same, publication: "pub-2" }, shown)).toBe(true);
	expect(publishedReadNeeded(undefined, { ...same, account_id: "other" }, shown)).toBe(true);
	expect(publishedReadNeeded(undefined, { ...same, publication: null }, shown)).toBe(false);
	expect(publishedReadNeeded(undefined, same, null)).toBe(true);
	expect(
		publishedReadNeeded(
			publicationKey({ ...same, publication: "pub-2" }),
			{ ...same, publication: "pub-2" },
			shown,
		),
	).toBe(false);
});
