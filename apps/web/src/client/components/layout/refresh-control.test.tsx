// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RefreshRun } from "../../../lib/refresh-types";
import { apiGet, apiPost } from "../../lib/api";
import { ApiError } from "../../lib/errors";
import { isRemoteReadOnly } from "../../lib/local-environment";
import { defaultRefreshParams } from "../../viewmodels/refresh";
import { setActiveAccountId } from "../../viewmodels/session";
import { RefreshControl } from "./refresh-control";
import { RefreshProvider } from "./refresh-provider";
import { useSnapshotRead } from "./use-snapshot-read";

vi.mock("../../lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock("../../lib/local-environment", () => ({ isRemoteReadOnly: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
const load = vi.fn().mockResolvedValue(1);
function Reader() {
	useSnapshotRead(
		load,
		() => undefined,
		() => undefined,
	);
	return <span>Saved view</span>;
}
function run(overrides: Partial<RefreshRun> = {}): RefreshRun {
	return {
		id: "run-1",
		accountId: "account-1",
		params: defaultRefreshParams(),
		trigger: "manual",
		status: "running",
		phase: "account",
		repos: [],
		completedRepos: 0,
		requests: 1,
		requestBreakdown: {
			total: 1,
			graphql: 1,
			rest: 0,
			a: { graphql: 1, rest: 0 },
			b: { graphql: 0, rest: 0 },
		},
		partialReasons: [],
		cancelRequested: false,
		partial: false,
		errorCode: null,
		createdAt: "2026-10-29T04:00:00Z",
		updatedAt: "2026-10-29T04:00:00Z",
		finishedAt: null,
		...overrides,
	};
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-29T04:00:00Z"));
	vi.resetAllMocks();
	vi.mocked(isRemoteReadOnly).mockReturnValue(false);
	load.mockResolvedValue(1);
	setActiveAccountId("account-1");
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
function button(text: string): HTMLButtonElement {
	const found = Array.from(document.querySelectorAll("button")).find((item) =>
		item.textContent?.includes(text),
	);
	if (!found) throw new Error(`Missing button: ${text}`);
	return found;
}
async function render(repo?: string) {
	await act(async () =>
		root.render(
			<RefreshProvider>
				<RefreshControl {...(repo ? { repo } : {})} />
				<Reader />
			</RefreshProvider>,
		),
	);
}
function empty() {
	vi.mocked(apiGet)
		.mockResolvedValueOnce({ items: [], collectionAvailable: true })
		.mockRejectedValueOnce(new ApiError(409, "snapshot_missing", "missing"));
}
it("offers one account refresh with yesterday, star/new selection and external schedule semantics", async () => {
	empty();
	await render();
	await act(async () => button("刷新数据").click());
	expect(document.body.textContent).toContain("所有星标仓库（不限所有者）");
	expect(document.body.textContent).toContain("本账号上海当日新建且未观测的非 fork 仓库");
	expect(document.body.textContent).not.toContain("新发现");
	expect(document.body.textContent).toContain("03:00");
	expect(document.body.textContent).toContain("04:30");
	expect(document.body.textContent).toContain("依赖分析");
	expect(document.body.textContent).not.toMatch(/快速刷新|深度刷新|每周|AI 分析/);
	expect(document.querySelector<HTMLInputElement>('[aria-label="开始日期"]')?.value).toBe(
		"2026-10-28",
	);
	vi.mocked(apiPost).mockResolvedValueOnce(run({ status: "queued" }));
	await act(async () => {
		button("开始刷新").click();
		button("开始刷新").click();
	});
	expect(apiPost).toHaveBeenCalledOnce();
	expect(apiPost).toHaveBeenCalledWith("refresh-runs", defaultRefreshParams());
	expect(button("刷新进行中").disabled).toBe(true);
	expect(document.body.textContent).toContain("A · 账号信息");
	vi.mocked(apiGet).mockResolvedValueOnce(
		run({ phase: "repos", repos: ["a/b", "a/c"], completedRepos: 1 }),
	);
	await act(async () => vi.advanceTimersByTimeAsync(3000));
	expect(document.body.textContent).toContain("1 / 2");
	vi.mocked(apiGet).mockResolvedValueOnce(
		run({ status: "partial", phase: "done", errorCode: "github_error" }),
	);
	await act(async () => vi.advanceTimersByTimeAsync(3000));
	expect(document.body.textContent).toContain("部分完成");
	expect(document.body.textContent).toContain("github_error");
	expect(document.body.textContent).toContain("缺失不代表零");
	expect(load).toHaveBeenCalledTimes(2);
});

it("labels an API-started lookback as starred-only in the current status", async () => {
	const backfill = run({
		params: { ...defaultRefreshParams(), lookbackDays: 90, since: "2026-07-31" },
	});
	vi.mocked(apiGet).mockResolvedValue({ items: [backfill], collectionAvailable: true });
	await render();
	await act(async () => button("刷新中").click());
	const status = document.querySelector('[role="status"]')?.textContent;
	expect(status).toContain("历史回填 · 仅星标仓库 · 90 天");
	expect(status).not.toContain("新建");
});

it("visibly disables an idle start while a background status read is pending", async () => {
	empty();
	await render();
	await act(async () => button("刷新数据").click());
	let finish: ((body: unknown) => void) | undefined;
	vi.mocked(apiGet)
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		)
		.mockRejectedValueOnce(new ApiError(409, "snapshot_missing", "missing"));
	await act(async () => window.dispatchEvent(new Event("focus")));
	expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
	expect(document.querySelector('[role="status"]')?.textContent).toContain("正在读取刷新状态");
	await act(async () => finish?.({ items: [], collectionAvailable: true }));
	expect(button("开始刷新").disabled).toBe(false);
	vi.mocked(apiPost).mockResolvedValueOnce(run());
	await act(async () => button("开始刷新").click());
	expect(apiPost).toHaveBeenCalledOnce();
});
it("starts an adhoc repo without changing stars and allows retrying status, never POST", async () => {
	empty();
	await render("nocoo/giraffe");
	await act(async () => button("刷新此仓库").click());
	expect(document.body.textContent).toContain("不改变星标");
	vi.mocked(apiPost).mockResolvedValueOnce(
		run({ params: { ...defaultRefreshParams(), repo: "nocoo/giraffe" } }),
	);
	await act(async () => button("开始刷新").click());
	expect(apiPost).toHaveBeenCalledWith("refresh-runs", {
		...defaultRefreshParams(),
		repo: "nocoo/giraffe",
	});
	vi.mocked(apiGet).mockRejectedValueOnce(new Error("secret"));
	await act(async () => vi.advanceTimersByTimeAsync(3000));
	expect(document.querySelector('[role="alert"]')?.textContent).toContain("重试");
	expect(document.body.textContent).not.toContain("secret");
	vi.mocked(apiGet).mockResolvedValueOnce(run({ status: "failed", phase: "done" }));
	await act(async () => button("重试读取状态").click());
	expect(document.body.textContent).toContain("刷新失败");
	expect(apiPost).toHaveBeenCalledOnce();
});
it("reads active status on navigation, pauses hidden polling and stops after unmount", async () => {
	vi.mocked(apiGet).mockResolvedValueOnce({ items: [run()], collectionAvailable: true });
	await render();
	const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
	await act(async () => vi.advanceTimersByTimeAsync(3000));
	expect(apiGet).toHaveBeenCalledOnce();
	visibility.mockReturnValue("visible");
	vi.mocked(apiGet).mockResolvedValueOnce(run());
	await act(async () => window.dispatchEvent(new Event("focus")));
	expect(apiGet).toHaveBeenLastCalledWith("refresh-runs/run-1");
	await act(async () => root.render(null));
	const count = vi.mocked(apiGet).mock.calls.length;
	await act(async () => vi.advanceTimersByTimeAsync(120_000));
	expect(apiGet).toHaveBeenCalledTimes(count);
	expect(apiPost).not.toHaveBeenCalled();
});

it("keeps empty dimensions invalid and sends chosen dimensions and force without legacy modes", async () => {
	empty();
	await render();
	await act(async () => button("刷新数据").click());
	const group = document.querySelector('[aria-label="刷新维度"]');
	const checkboxes = Array.from(
		group?.querySelectorAll<HTMLButtonElement>('[role="checkbox"]') ?? [],
	);
	for (const checkbox of checkboxes) await act(async () => checkbox.click());
	await act(async () => button("开始刷新").click());
	expect(apiPost).not.toHaveBeenCalled();
	expect(document.querySelector('[role="alert"]')?.textContent).toContain("维度");
	await act(async () => checkboxes[0]?.click());
	const force = document.querySelector<HTMLButtonElement>('label[for$="-force"] button');
	await act(async () => force?.click());
	vi.mocked(apiPost).mockResolvedValueOnce(run());
	await act(async () => button("开始刷新").click());
	expect(apiPost).toHaveBeenCalledWith("refresh-runs", {
		...defaultRefreshParams(),
		dimensions: ["commits"],
		force: true,
	});
});

it.each(["read-only", "unavailable", "unknown"])("does not submit in %s state", async (reason) => {
	if (reason === "unknown") vi.mocked(apiGet).mockRejectedValueOnce(new Error("unknown"));
	else {
		vi.mocked(apiGet)
			.mockResolvedValueOnce({ items: [], collectionAvailable: reason !== "unavailable" })
			.mockRejectedValueOnce(new ApiError(409, "snapshot_missing", "missing"));
	}
	if (reason === "read-only") vi.mocked(isRemoteReadOnly).mockReturnValue(true);
	await render();
	await act(async () => button("刷新数据").click());
	expect(button("开始刷新").disabled).toBe(true);
	await act(async () => button("开始刷新").click());
	expect(apiPost).not.toHaveBeenCalled();
});

it("queues a data revalidation when a terminal run arrives during an older snapshot read", async () => {
	vi.mocked(apiGet).mockResolvedValueOnce({ items: [run()], collectionAvailable: true });
	let finish: ((value: number) => void) | undefined;
	load.mockImplementationOnce(
		() =>
			new Promise<number>((resolve) => {
				finish = resolve;
			}),
	);
	await render();
	vi.mocked(apiGet).mockResolvedValueOnce(run({ status: "completed", phase: "done" }));
	await act(async () => vi.advanceTimersByTimeAsync(3000));
	expect(load).toHaveBeenCalledOnce();
	await act(async () => finish?.(1));
	expect(load).toHaveBeenCalledTimes(2);
});

it("shares the active lock across account and adhoc controls", async () => {
	empty();
	await act(async () =>
		root.render(
			<RefreshProvider>
				<RefreshControl />
				<RefreshControl repo="nocoo/giraffe" />
			</RefreshProvider>,
		),
	);
	await act(async () => button("刷新此仓库").click());
	vi.mocked(apiPost).mockResolvedValueOnce(run());
	await act(async () => button("开始刷新").click());
	await act(async () =>
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
	);
	const account = container.querySelector<HTMLButtonElement>('[aria-label="刷新数据"]');
	await act(async () => account?.click());
	expect(button("刷新进行中").disabled).toBe(true);
	expect(apiPost).toHaveBeenCalledOnce();
});
