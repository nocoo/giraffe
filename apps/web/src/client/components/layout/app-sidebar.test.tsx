// @vitest-environment happy-dom
import { LinkProvider, TooltipProvider } from "@nocoo/basalt";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { APP_VERSION } from "../../../lib/version";
import { RouterLink } from "../../app";
import { NAV_GROUPS, NAV_ITEMS } from "../../lib/navigation";
import { AppSidebar } from "./app-sidebar";

vi.mock("./use-project-identity", () => ({ useProjectIdentity: () => null }));

function sidebar(collapsed = false, path = "/factory") {
	const container = document.createElement("div");
	container.innerHTML = renderToStaticMarkup(
		<MemoryRouter initialEntries={[path]}>
			<LinkProvider render={RouterLink}>
				<TooltipProvider>
					<AppSidebar collapsed={collapsed} onToggle={() => {}} />
				</TooltipProvider>
			</LinkProvider>
		</MemoryRouter>,
	);
	return container;
}

describe("Basalt sidebar composition", () => {
	it("uses template disclosures without changing destination order", () => {
		const nav = sidebar().querySelector("nav");
		expect(
			Array.from(nav?.querySelectorAll("button[aria-expanded]") ?? [], (node) => [
				node.textContent,
				node.getAttribute("aria-expanded"),
			]),
		).toEqual(NAV_GROUPS.map((group) => [group.label, "true"]));
		expect(
			Array.from(nav?.querySelectorAll("button:not([aria-expanded])") ?? [], (node) =>
				node.textContent?.trim(),
			),
		).toEqual(NAV_ITEMS.map((item) => item.label));
	});

	it("links the brand home and keeps the version only beside the title", () => {
		const container = sidebar();
		const home = container.querySelector('a[aria-label="Giraffe 首页"]');
		expect(home?.getAttribute("href")).toBe("/");
		expect(home?.querySelector("img")?.getAttribute("width")).toBe("28");
		expect(home?.textContent).toBe(`Giraffev${APP_VERSION}`);
		expect(container.textContent?.match(new RegExp(`v${APP_VERSION}`, "g"))).toHaveLength(1);
	});

	it("uses the centered collapsed rail with search inside navigation", () => {
		const container = sidebar(true, "/repos/octocat/hello-world");
		expect(container.querySelector('a[aria-label="Giraffe 首页"]')?.textContent).toBe("");
		expect(container.textContent).not.toContain(`v${APP_VERSION}`);
		const nav = container.querySelector("nav");
		expect(nav?.querySelector("button")?.getAttribute("aria-label")).toBe("搜索 (⌘K)");
		expect(nav?.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe("仓库");
		expect(
			Array.from(nav?.querySelectorAll("button") ?? [], (node) => node.getAttribute("aria-label")),
		).toEqual(["搜索 (⌘K)", ...NAV_ITEMS.map((item) => item.label)]);
	});
});
