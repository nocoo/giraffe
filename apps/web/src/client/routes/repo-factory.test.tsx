// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import type { FactoryCoverage, FactoryEvent, FactoryStreamName } from "../../lib/factory-types";
import { ApiError } from "../lib/errors";
import { loadFactoryDetail } from "../viewmodels/factory";
import { RepoFactoryTab } from "./repo-factory";

vi.mock("../viewmodels/factory", async (original) => ({
	...(await original<typeof import("../viewmodels/factory")>()),
	loadFactoryDetail: vi.fn(),
}));
const refreshModel = vi.hoisted(() => {
	const listeners = new Set<() => void>();
	return {
		listeners,
		subscribeData: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
});
vi.mock("../components/layout/refresh-provider", () => ({ useRefreshModel: () => refreshModel }));

afterEach(() => {
	refreshModel.listeners.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("rereads the current factory record page after refresh without resetting pagination", async () => {
	vi.mocked(loadFactoryDetail).mockResolvedValue({
		account_id: "a".repeat(21),
		runId: "run",
		repo: "nocoo/app",
		stream: "prs",
		coverage,
		page: 1,
		total: 101,
		items: [event({})],
	});
	const { container, root } = await render();
	try {
		const next = Array.from(container.querySelectorAll("button")).find(
			(item) => item.textContent === "下一页",
		);
		await act(async () => next?.click());
		expect(container.textContent).toContain("第 2/2 页");
		expect(refreshModel.listeners.size).toBe(1);
		vi.mocked(loadFactoryDetail).mockClear();
		await act(async () => {
			for (const listener of refreshModel.listeners) listener();
		});
		expect(loadFactoryDetail).toHaveBeenCalledOnce();
		expect(loadFactoryDetail).toHaveBeenCalledWith("nocoo/app", "prs", 2, "", "", "all");
		expect(container.textContent).toContain("第 2/2 页");
	} finally {
		await act(async () => root.unmount());
	}
	expect(refreshModel.listeners.size).toBe(0);
});

const coverage: FactoryCoverage = {
	status: "complete",
	pages: 1,
	fetchedAt: "2026-10-24T21:52:10.637Z",
	source: "/repos/nocoo/app/pulls?state=all&per_page=100",
	reason: null,
	observed: 2,
};

function event(overrides: Partial<FactoryEvent>): FactoryEvent {
	return {
		id: "PR_1",
		title: "fix: keep the run alive",
		url: "https://github.com/nocoo/app/pull/115",
		at: "2026-10-24T20:20:48Z",
		createdAt: "2026-10-24T20:20:48Z",
		closedAt: "2026-10-24T20:35:30Z",
		mergedAt: "2026-10-24T20:35:30Z",
		author: "nocoo",
		state: "merged",
		...overrides,
	};
}

async function render(stream: FactoryStreamName = "prs") {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.createElement("div");
	const root = createRoot(container);
	const onStream = vi.fn();
	await act(async () =>
		root.render(
			<MemoryRouter>
				<RepoFactoryTab
					repo="nocoo/app"
					days={["2026-10-23", "2026-10-24"]}
					stream={stream}
					onStream={onStream}
				/>
			</MemoryRouter>,
		),
	);
	return { container, root, onStream };
}

it("keeps skipped dependency resources missing instead of showing zero observations", async () => {
	vi.mocked(loadFactoryDetail).mockRejectedValue(new ApiError(409, "snapshot_missing", "missing"));
	const { container, root } = await render("dependencies");
	try {
		expect(container.querySelector('[role="alert"]')?.textContent).toBe(
			"暂无已保存的资源快照；缺失不代表没有记录。",
		);
		expect(container.querySelector(".factory-provenance")).toBeNull();
		expect(container.textContent).not.toContain("0 条观察记录");
	} finally {
		await act(async () => root.unmount());
	}
});

it("renders a pull request record with state, review, checks, author and merge time", async () => {
	vi.mocked(loadFactoryDetail).mockResolvedValue({
		account_id: "a".repeat(21),
		runId: "run",
		repo: "nocoo/app",
		stream: "prs",
		coverage,
		page: 1,
		total: 1,
		items: [
			event({
				review: "APPROVED",
				checks: { state: "SUCCESS" },
				merged_by: "nocoo",
				base_ref: "main",
			}),
		],
	});
	const { container, root } = await render();
	try {
		expect(loadFactoryDetail).toHaveBeenCalledWith("nocoo/app", "prs", 1, "", "", "all");
		const text = container.textContent ?? "";
		expect(text).toContain("fix: keep the run alive");
		expect(text).toContain("#115");
		expect(text).toContain("已合并");
		expect(text).toContain("已批准");
		expect(text).toContain("检查通过");
		expect(text).toContain("nocoo");
		expect(text).toContain("覆盖");
		expect(text).toContain("完整");
		expect(text).toContain("1 条观察记录");
	} finally {
		await act(async () => root.unmount());
	}
});

it("shows CI workflow, attempt and duration for the actions stream", async () => {
	vi.mocked(loadFactoryDetail).mockResolvedValue({
		account_id: "a".repeat(21),
		runId: "run",
		repo: "nocoo/app",
		stream: "actions",
		coverage,
		page: 1,
		total: 1,
		items: [
			event({
				title: "Release",
				state: "completed",
				conclusion: "success",
				mergedAt: null,
				closedAt: null,
				activityRun: {
					workflow_name: "Release",
					path: ".github/workflows/release.yml",
					head_branch: "main",
					run_attempt: 2,
					duration_s: 36,
				} as never,
			}),
		],
	});
	const { container, root } = await render("actions");
	try {
		const text = container.textContent ?? "";
		expect(text).toContain(".github/workflows/release.yml");
		expect(text).toContain("成功");
		expect(text).toContain("#2");
		expect(text).toContain("36s");
		expect(text).not.toContain("审查 / CI");
	} finally {
		await act(async () => root.unmount());
	}
});

it("asks for a state filter and keeps an incomplete stream explicit", async () => {
	vi.mocked(loadFactoryDetail).mockResolvedValue({
		account_id: "a".repeat(21),
		runId: "run",
		repo: "nocoo/app",
		stream: "issues",
		coverage: { ...coverage, status: "limited", reason: "分页上限", observed: 0 },
		page: 1,
		total: 0,
		items: [],
	});
	const { container, root } = await render("issues");
	try {
		expect(container.textContent).toContain("分页上限");
		expect(container.textContent).toContain("已截断");
		expect(container.textContent).toContain("尚无可读记录；不代表 GitHub 中为零。");
	} finally {
		await act(async () => root.unmount());
	}
});
