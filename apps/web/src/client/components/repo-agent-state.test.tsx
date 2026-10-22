// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadRepoAgentState } from "../viewmodels/repo-agent-state";
import { RepoAgentStateCard } from "./repo-agent-state";

vi.mock("../viewmodels/repo-agent-state", async (original) => ({
	...(await original<object>()),
	loadRepoAgentState: vi.fn(),
}));
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
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});
const state = {
	account_id: "a",
	repo: "owner/app",
	repo_removed: false,
	payload: {
		summary: "<script>unsafe()</script>",
		status: "blocked",
		last_reviewed_at: "2026-10-22T00:00:00Z",
	},
	revision: 1,
	updated_at: "2026-10-22T01:00:00Z",
	updated_by: "token",
};

it("R5 detail renders escaped agent summary, status, review time and removal without edit controls", async () => {
	vi.mocked(loadRepoAgentState).mockResolvedValue({ ...state, repo_removed: true });
	await act(async () => root.render(<RepoAgentStateCard owner="owner" name="app" />));
	expect(container.textContent).toContain("<script>unsafe()</script>");
	expect(container.querySelector("script")).toBeNull();
	expect(container.textContent).toContain("阻塞");
	expect(container.textContent).toContain("2026-10-22");
	expect(container.textContent).toContain("仓库已移除");
	expect(container.querySelector("input,textarea")).toBeNull();
});

it("R5 detail isolates load failures and retries without replacing repository content", async () => {
	vi.mocked(loadRepoAgentState)
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValueOnce({ ...state, payload: null, revision: null });
	await act(async () => root.render(<RepoAgentStateCard owner="owner" name="app" />));
	expect(container.textContent).toContain("管家备注暂时不可用");
	await act(async () => container.querySelector("button")?.click());
	expect(container.textContent).toContain("暂无管家备注");
});

it("R5 detail ignores a stale response after repository navigation", async () => {
	let resolve: (value: typeof state) => void = () => {};
	vi.mocked(loadRepoAgentState)
		.mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		)
		.mockResolvedValueOnce({ missing: true });
	await act(async () => root.render(<RepoAgentStateCard owner="owner" name="app" />));
	expect(container.textContent).toContain("读取管家备注");
	await act(async () => root.render(<RepoAgentStateCard owner="owner" name="other" />));
	await act(async () => resolve(state));
	expect(container.textContent).toContain("暂无管家备注");
	expect(container.textContent).not.toContain("unsafe");
});
