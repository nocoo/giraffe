// @vitest-environment happy-dom
import { TooltipProvider } from "@nocoo/basalt";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BusinessPageHeader } from "./business-page-header";

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

async function render(title: React.ReactNode = "仓库") {
	await act(async () =>
		root.render(
			<TooltipProvider>
				<BusinessPageHeader
					title={title}
					description="当前账号下的仓库快照"
					meta={<span data-testid="meta">数据时间 10:00</span>}
					filters={<span data-testid="filters">筛选</span>}
					actions={
						<button type="button" data-testid="action">
							操作
						</button>
					}
				/>
			</TooltipProvider>,
		),
	);
}

it("keeps the description behind a title-adjacent info tooltip", async () => {
	await render();
	expect(container.querySelector("h1")?.textContent).toBe("仓库");
	expect(container.textContent).not.toContain("当前账号下的仓库快照");
	const info = container.querySelector<HTMLButtonElement>('[aria-label="仓库说明"]');
	expect(info?.querySelector("svg.lucide-info")).not.toBeNull();
	expect(document.querySelector('[role="tooltip"]')).toBeNull();
	await act(async () => info?.focus());
	expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("当前账号下的仓库快照");
	await act(async () => info?.blur());
	expect(document.querySelector('[role="tooltip"]')).toBeNull();
});

it("keeps scope, data-time, filter and action labels in the header row", async () => {
	await render();
	expect(container.querySelector('[data-testid="meta"]')).not.toBeNull();
	expect(container.querySelector('[data-testid="filters"]')).not.toBeNull();
	expect(container.querySelector('[data-testid="action"]')?.textContent).toBe("操作");
	expect(container.querySelector("fieldset legend")?.textContent).toBe("仓库范围");
});

it("names a non-text title with a generic accessible label", async () => {
	await render(<span>仓库</span>);
	expect(container.querySelector('[aria-label="页面说明"]')).not.toBeNull();
});
