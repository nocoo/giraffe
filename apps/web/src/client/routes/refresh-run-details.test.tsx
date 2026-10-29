// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RefreshRun } from "../../lib/refresh-types";
import { defaultRefreshParams } from "../viewmodels/refresh";
import { RefreshRunDetails } from "./refresh-run-details";

vi.mock("../components/layout/project-identity", () => ({
	ProjectLabel: ({ repo }: { repo: string }) => <span>{repo}</span>,
	ProjectName: ({ repo }: { repo: string }) => <span>{repo}</span>,
	ProjectLinks: () => null,
}));

const NOW = Date.parse("2026-10-29T04:10:00Z");

function run(overrides: Partial<RefreshRun> = {}): RefreshRun {
	return {
		id: "run-1",
		accountId: "account-1",
		params: defaultRefreshParams(new Date("2026-10-29T04:00:00Z")),
		trigger: "manual",
		status: "partial",
		phase: "done",
		repos: ["nocoo/app", "nocoo/web"],
		completedRepos: 2,
		requests: 6,
		requestBreakdown: {
			total: 6,
			graphql: 2,
			rest: 4,
			a: { graphql: 1, rest: 0 },
			b: { graphql: 1, rest: 4 },
		},
		partialReasons: [
			{
				repo: "nocoo/app",
				codes: ["issues:inventory_incomplete"],
				failures: [
					{
						dimension: "issues",
						code: "inventory_incomplete",
						httpStatus: 200,
						graphqlType: "Repository",
						graphqlPath: ["repository", "issues"],
					},
				],
			},
		],
		partial: true,
		aReused: false,
		cancelRequested: false,
		errorCode: null,
		createdAt: "2026-10-29T04:00:00Z",
		updatedAt: "2026-10-29T04:03:00Z",
		finishedAt: "2026-10-29T04:03:00Z",
		...overrides,
	};
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

async function render(element: ReactNode) {
	await act(async () => root.render(element));
}

it("opens a retained historical run without manufacturing missing diagnostics", async () => {
	const historical = run();
	Reflect.deleteProperty(historical, "partialReasons");
	Reflect.deleteProperty(historical, "requestBreakdown");
	Reflect.deleteProperty(historical, "cancelRequested");
	await render(<RefreshRunDetails run={historical} now={NOW} />);
	expect(container.textContent).toContain("结果未记录");
	expect(container.textContent).toContain("未记录 3");
	expect(container.querySelectorAll('[data-state="unknown"]')).toHaveLength(24);
	expect(container.querySelectorAll('[data-state="complete"]')).toHaveLength(0);
});

it("renders per-repository dimensions, reasons, request split and step timings", async () => {
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
					finishedAt: "2026-10-29T04:02:15Z",
					attempts: 1,
				},
			],
		},
	} as RefreshRun;
	await render(<RefreshRunDetails run={timed} now={NOW} />);
	const text = container.textContent ?? "";
	expect(text).toContain("部分完成 · 2026-10-28 → 2026-10-28 · Asia/Shanghai");
	expect(text).toContain("2 / 2 个仓库已处理 · 1 个部分完成");
	expect(text).toContain("GitHub 请求 · A / B 拆分");
	expect(text).toContain("Issues · Issue 清单未完整");
	expect(text).toContain("HTTP 200 · Issues · GraphQL Repository · repository.issues");
	expect(text).toContain("A 开始");
	expect(text).toContain("结束 2026年10月29日 12:01:15 · 耗时 1 分 0 秒 · 尝试 2 次");
	expect(text).toContain("5 / 6 维度");
	expect(text).toContain("提交已处理");
	expect(text).not.toContain("提交完整");
	expect(text).toContain("Issues部分");
	expect(text).not.toContain("结束本次刷新");
});

it("explains a failed account run and an empty B without inventing repositories", async () => {
	await render(
		<RefreshRunDetails
			run={run({
				status: "failed",
				phase: "done",
				repos: [],
				completedRepos: 0,
				partialReasons: [],
				errorCode: "refresh_schema_cutover",
				aReused: true,
			})}
			now={NOW}
		/>,
	);
	const text = container.textContent ?? "";
	expect(text).toContain("刷新失败");
	expect(text).toContain("运行错误");
	expect(text).toContain("旧版刷新记录已停止执行");
	expect(text).toContain("A · 账号信息、贡献与仓库清单");
	expect(text).toContain("复用当日账号数据，0 次上游请求");
	expect(text).toContain("还没有仓库进入 B");
	expect(text).toContain("这次运行没有保存逐步时间戳");
});

it("keeps active cancellation and an older request payload honest", async () => {
	const cancel = vi.fn();
	await render(
		<RefreshRunDetails
			run={run({
				status: "running",
				phase: "repos",
				completedRepos: 0,
				finishedAt: null,
				partialReasons: [],
				requestBreakdown: undefined as never,
				cancelRequested: false,
			})}
			now={NOW}
			onCancel={cancel}
		/>,
	);
	const text = container.textContent ?? "";
	expect(text).toContain("只保存了共 6 次请求，没有记录 A/B 拆分");
	expect(text).toContain("进行中");
	await act(async () => {
		const button = Array.from(container.querySelectorAll("button")).find((item) =>
			item.textContent?.includes("结束本次刷新"),
		);
		button?.click();
	});
	expect(cancel).toHaveBeenCalledOnce();
});

it("renders a cancellation-closed account step as interrupted without settled attempts", async () => {
	const cancelled = {
		...run({
			status: "cancelled",
			phase: "done",
			repos: [],
			completedRepos: 0,
			requests: 0,
			requestBreakdown: {
				total: 0,
				graphql: 0,
				rest: 0,
				a: { graphql: 0, rest: 0 },
				b: { graphql: 0, rest: 0 },
			},
			partialReasons: [],
			partial: false,
			cancelRequested: true,
			finishedAt: "2026-10-29T04:05:00Z",
		}),
		timings: {
			queuedAt: "2026-10-29T04:00:00Z",
			a: {
				startedAt: "2026-10-29T04:00:00Z",
				finishedAt: "2026-10-29T04:05:00Z",
				attempts: 0,
				reused: false,
			},
			repos: [],
		},
	} as RefreshRun;
	await render(<RefreshRunDetails run={cancelled} now={NOW} />);
	const phases = container.querySelectorAll(".refresh-run-phases > li");
	expect(phases[0]?.getAttribute("data-complete")).toBe("false");
	expect(phases[0]?.textContent).toContain("已中断");
	expect(phases[0]?.textContent).toContain(
		"结束 2026年10月29日 12:05:00 · 耗时 5 分 0 秒 · 尝试 0 次",
	);
	const text = container.textContent ?? "";
	expect(text).toContain("0 / 1");
	expect(text).not.toContain("完成 2026");
	expect(text).toContain("结束时间表示步骤结束，不代表成功完成采集");
	expect(text).not.toContain("未完成的步骤只显示已开始时间");
});

it("uses neutral end-time wording for a cancellation-closed interrupted repository", async () => {
	const cancelled = {
		...run({
			status: "cancelled",
			phase: "done",
			completedRepos: 0,
			partialReasons: [],
			partial: false,
			cancelRequested: true,
			finishedAt: "2026-10-29T04:05:00Z",
		}),
		timings: {
			queuedAt: "2026-10-29T04:00:00Z",
			a: {
				startedAt: "2026-10-29T04:00:00Z",
				finishedAt: "2026-10-29T04:00:10Z",
				attempts: 1,
				reused: false,
			},
			repos: [
				{
					repo: "nocoo/app",
					startedAt: "2026-10-29T04:00:10Z",
					finishedAt: "2026-10-29T04:05:00Z",
					attempts: 0,
				},
			],
		},
	} as RefreshRun;
	await render(<RefreshRunDetails run={cancelled} now={NOW} />);
	const text = container.textContent ?? "";
	expect(text).toContain("结束 2026年10月29日 12:05:00 · 耗时 4 分 50 秒 · 尝试 0 次");
	expect(text).not.toContain("完成 2026年10月29日");
	expect(
		container.querySelector('details.refresh-run-row[data-status="interrupted"]'),
	).not.toBeNull();
});

it("marks cancelled terminal leftovers as unexecuted with interrupted timings", async () => {
	const cancelled = {
		...run({
			status: "cancelled",
			phase: "done",
			completedRepos: 0,
			partialReasons: [],
			cancelRequested: true,
			finishedAt: "2026-10-29T04:05:00Z",
		}),
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
	await render(<RefreshRunDetails run={cancelled} now={NOW} />);
	const text = container.textContent ?? "";
	expect(text).toContain("已取消");
	expect(text).toContain("已请求取消，当前步骤结束后停止。");
	expect(text).toContain("开始 2026年10月29日 12:00:15 · 未完成");
	expect(text).toContain("已中断");
	expect(text).toContain("未完成");
	expect(text).toContain("0 / 2 个仓库已处理");
});
