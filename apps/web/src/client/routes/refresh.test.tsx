// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RefreshRun } from "../../lib/refresh-types";
import { apiGet } from "../lib/api";
import { ApiError } from "../lib/errors";
import { defaultRefreshParams } from "../viewmodels/refresh";
import { RefreshCenter } from "./refresh";

vi.mock("../lib/api", () => ({ apiGet: vi.fn() }));
vi.mock("../components/layout/project-identity", () => ({
	ProjectLabel: ({ repo }: { repo: string }) => <span>{repo}</span>,
	ProjectName: ({ repo }: { repo: string }) => <span>{repo}</span>,
	ProjectLinks: () => null,
}));

type Live = Parameters<typeof RefreshCenter>[0]["model"];

function run(overrides: Partial<RefreshRun> = {}): RefreshRun {
	return {
		id: "run-1",
		accountId: "account-1",
		params: defaultRefreshParams(new Date("2026-10-29T04:00:00Z")),
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

function model(current: RefreshRun | null, overrides: Record<string, unknown> = {}) {
	const state = {
		accountId: "account-1",
		run: current,
		loading: false,
		reading: false,
		starting: false,
		cancelling: false,
		available: true,
		ready: true,
		error: null,
		...overrides,
	};
	return {
		getSnapshot: () => state,
		subscribe: () => () => undefined,
		subscribeData: () => () => undefined,
		read: vi.fn(async () => undefined),
		start: vi.fn(async () => undefined),
		cancel: vi.fn(async () => undefined),
	} as unknown as Live;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-29T04:10:00Z"));
	vi.resetAllMocks();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function button(text: string): HTMLButtonElement {
	const found = Array.from(container.querySelectorAll("button")).find((item) =>
		item.textContent?.includes(text),
	);
	if (!found) throw new Error(`Missing button: ${text}`);
	return found;
}

async function tab(text: string) {
	const target = exactButton(text);
	await act(async () => {
		target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		target.click();
	});
}

function exactButton(text: string): HTMLButtonElement {
	const found = Array.from(container.querySelectorAll("button")).find(
		(item) => item.textContent?.trim() === text,
	);
	if (!found) throw new Error(`Missing button: ${text}`);
	return found;
}

async function render(value: Live) {
	await act(async () =>
		root.render(
			<MemoryRouter initialEntries={["/refresh"]}>
				<RefreshCenter model={value} />
			</MemoryRouter>,
		),
	);
}

it("restores the refresh console with current A/B progress, requests and cancellation", async () => {
	vi.mocked(apiGet).mockResolvedValue({ items: [run()], collectionAvailable: true });
	const value = model(run());
	await render(value);
	const text = container.textContent ?? "";
	expect(text).toContain("刷新中心");
	expect(text).toContain("刷新中 · 手动 · 星标仓库 + 上海当日新建且未观测的非 fork 仓库");
	expect(text).toContain("B · nocoo/web · 2 / 2");
	expect(text).toContain("A · 账号信息、贡献与仓库清单");
	expect(text).toContain("GitHub 请求 · A / B 拆分");
	expect(text).toContain("A · 账号");
	expect(text).toContain("运行记录");
	expect(text).not.toMatch(/快速刷新|深度刷新|同步仓库列表/);
	await act(async () => button("结束刷新").click());
	expect(value.cancel).toHaveBeenCalledOnce();
});

it("drills into a historical run and returns to the live run", async () => {
	const current = run();
	const old = run({
		id: "run-0",
		params: { ...current.params, repo: "nocoo/old" },
		status: "partial",
		phase: "done",
		completedRepos: 2,
		finishedAt: "2026-10-29T03:00:00Z",
		partialReasons: [{ repo: "nocoo/old", codes: ["issues:inventory_incomplete"] }],
	});
	vi.mocked(apiGet).mockResolvedValue({ items: [current, old], collectionAvailable: true });
	await render(model(current));
	expect(container.textContent?.match(/单仓库 · nocoo\/old/g)).toHaveLength(1);
	await act(async () => exactButton("查看").click());
	expect(container.textContent?.match(/单仓库 · nocoo\/old/g)).toHaveLength(2);
	expect(container.textContent).toContain("Issue 清单未完整");
	expect(button("回到当前")).not.toBeNull();
	await act(async () => button("回到当前").click());
	expect(container.textContent).toContain("B · nocoo/web · 2 / 2");
});

it("starts a unified refresh from the plan tab and never exposes legacy modes", async () => {
	vi.mocked(apiGet).mockResolvedValue({ items: [], collectionAvailable: true });
	const value = model(null);
	await render(value);
	await tab("发起刷新");
	expect(container.textContent).toContain("无快速 / 深度模式");
	const repo = container.querySelector<HTMLInputElement>('[aria-label="指定仓库 owner/name"]');
	expect(repo?.value).toBe("");
	await act(async () => button("开始刷新").click());
	expect(value.start).toHaveBeenCalledWith(defaultRefreshParams(new Date("2026-10-29T04:10:00Z")));
	expect(container.textContent).not.toContain("快速刷新");
});

it("blocks an invalid dimension selection without posting", async () => {
	vi.mocked(apiGet).mockResolvedValue({ items: [], collectionAvailable: true });
	const value = model(null);
	await render(value);
	await tab("发起刷新");
	for (const checkbox of container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')) {
		await act(async () => checkbox.click());
	}
	expect(container.textContent).toContain("请选择非空且不重复的刷新维度");
	expect(button("开始刷新").disabled).toBe(true);
	expect(value.start).not.toHaveBeenCalled();
});

it("shows an empty history and leads to the first refresh", async () => {
	vi.mocked(apiGet).mockResolvedValue({ items: [], collectionAvailable: true });
	await render(model(null));
	expect(container.textContent).toContain("还没有刷新记录");
	await act(async () => button("发起第一次刷新").click());
	expect(button("开始刷新")).not.toBeNull();
});

it("retries a failed history read and exposes a model read failure", async () => {
	vi.mocked(apiGet).mockRejectedValueOnce(new ApiError(503, "db_error", "unavailable"));
	const value = model(run(), { error: "无法读取或启动刷新，请重试读取状态。" });
	await render(value);
	expect(container.textContent).toContain("无法读取或启动刷新，请重试读取状态。");
	expect(container.textContent).toContain("重试读取记录");
	vi.mocked(apiGet).mockResolvedValue({ items: [run()], collectionAvailable: true });
	await act(async () => button("重试读取记录").click());
	expect(container.textContent).toContain("运行记录");
	await act(async () => button("重试读取").click());
	expect(value.read).toHaveBeenCalled();
});

it("keeps a requested cancellation visible and disables the action", async () => {
	vi.mocked(apiGet).mockResolvedValue({
		items: [run({ cancelRequested: true })],
		collectionAvailable: true,
	});
	await render(model(run({ cancelRequested: true })));
	expect(container.textContent).toContain("已请求取消，当前步骤结束后停止。");
	expect(button("等待停止").disabled).toBe(true);
});

it("shows the fixed daily schedule instead of editable legacy plans", async () => {
	vi.mocked(apiGet).mockResolvedValue({ items: [], collectionAvailable: true });
	await render(model(null));
	await tab("自动刷新");
	expect(container.textContent).toContain("每日 03:00 Asia/Shanghai");
	expect(container.textContent).toContain("04:30");
	expect(container.textContent).not.toContain("每周");
	expect(container.textContent).not.toContain("保存计划");
});
