// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SnapshotPending } from "./snapshot-pending";

it.each([false, true])(
	"keeps missing snapshots honest and directs users to unified refresh or account settings: %s",
	async (needsAccount) => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<SnapshotPending
						state={{ missing: true, ...(needsAccount ? { title: "请先连接 GitHub 账号" } : {}) }}
					/>,
				),
			);
			expect(container.textContent).toContain("统一刷新");
			expect(container.textContent).not.toContain("旧刷新已停用");
			expect(container.querySelector('a[href="/refresh"]')).toBeNull();
			if (needsAccount) {
				expect(container.querySelector('a[href="/settings"]')).not.toBeNull();
			} else {
				expect(container.querySelector("button[disabled]")).toBeNull();
			}
		} finally {
			await act(async () => root.unmount());
			vi.unstubAllGlobals();
		}
	},
);
