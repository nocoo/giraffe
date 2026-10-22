// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadRepoMeta } from "../viewmodels/repo-meta";
import { RepoMetaCard } from "./repo-meta";

vi.mock("../viewmodels/repo-meta", async (original) => ({
	...(await original<object>()),
	loadRepoMeta: vi.fn(),
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
const meta = {
	account_id: "a",
	repo: "owner/app",
	repo_removed: false,
	created_at: "2020-06-07T08:00:00Z",
	first_seen_at: null,
	archived_at: null,
	deleted_at: null,
	category: "docs-vault" as const,
	exclusion_reason: null,
	updated_at: "2026-10-22T00:00:00Z",
	field_sources: { created_at: "agent" as const, category: "agent" as const },
};

it("R6 detail shows creation date and category without owner-edit controls", async () => {
	vi.mocked(loadRepoMeta).mockResolvedValue(meta);
	await act(async () => root.render(<RepoMetaCard owner="owner" name="app" />));
	expect(container.textContent).toContain("2020-06-07");
	expect(container.textContent).toContain("文档库");
	expect(container.querySelector("input,textarea,select")).toBeNull();
});
it("R6 metadata failure is independent and retry restores empty metadata", async () => {
	vi.mocked(loadRepoMeta)
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValueOnce({ ...meta, created_at: null, category: null });
	await act(async () => root.render(<RepoMetaCard owner="owner" name="app" />));
	expect(container.textContent).toContain("仓库档案暂时不可用");
	await act(async () => container.querySelector("button")?.click());
	expect(container.textContent).toContain("未分类");
	expect(container.textContent).toContain("—");
});
it("R6 metadata ignores a stale response after repository navigation", async () => {
	let resolve: (value: typeof meta) => void = () => {};
	vi.mocked(loadRepoMeta)
		.mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		)
		.mockResolvedValueOnce({ missing: true });
	await act(async () => root.render(<RepoMetaCard owner="owner" name="app" />));
	expect(container.textContent).toContain("读取仓库档案");
	await act(async () => root.render(<RepoMetaCard owner="owner" name="other" />));
	await act(async () => resolve(meta));
	expect(container.textContent).toContain("暂无仓库档案");
	expect(container.textContent).not.toContain("文档库");
});
