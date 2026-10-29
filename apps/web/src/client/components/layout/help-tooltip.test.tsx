// @vitest-environment happy-dom
import { TooltipProvider } from "@nocoo/basalt";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HelpTooltip } from "./help-tooltip";

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

async function render() {
	await act(async () =>
		root.render(
			<TooltipProvider>
				<HelpTooltip label="当次窗口说明">
					<p>北京时间，起点不含、终点包含。</p>
				</HelpTooltip>
			</TooltipProvider>,
		),
	);
	return container.querySelector<HTMLButtonElement>("button");
}

it("keeps the explanation behind a labelled info button", async () => {
	const button = await render();
	expect(button?.getAttribute("aria-label")).toBe("当次窗口说明");
	expect(button?.querySelector("svg.lucide-info")).not.toBeNull();
	expect(document.body.textContent).not.toContain("北京时间");
});

it("opens on keyboard focus and pointer activation, and closes on blur", async () => {
	const button = await render();
	if (!button) throw new Error("Missing info button");
	await act(async () => button.focus());
	expect(document.body.textContent).toContain("北京时间");
	await act(async () => button.blur());
	expect(document.body.textContent).not.toContain("北京时间");
	await act(async () => button.click());
	expect(document.body.textContent).toContain("北京时间");
});
