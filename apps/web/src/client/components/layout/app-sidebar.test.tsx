// @vitest-environment happy-dom
import { LinkProvider, SidebarProvider, TooltipProvider } from "@nocoo/basalt";
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
					<SidebarProvider collapsed={collapsed} defaultWidth={260}>
						<AppSidebar ariaLabel="主导航" />
					</SidebarProvider>
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
			Array.from(nav?.querySelectorAll("a[data-sidebar-row]") ?? [], (node) =>
				node.textContent?.trim(),
			),
		).toEqual(NAV_ITEMS.map((item) => item.label));
	});

	it("links the brand home and keeps the version only beside the title", () => {
		const container = sidebar();
		const home = container.querySelector('a[aria-label="Giraffe 首页"]');
		expect(home?.getAttribute("href")).toBe("/");
		expect(home?.querySelector("img")?.getAttribute("width")).toBe("24");
		expect(container.querySelector('[data-slot="sidebar-brand-name"]')?.textContent).toBe(
			"Giraffe",
		);
		expect(container.textContent?.match(new RegExp(`v${APP_VERSION}`, "g"))).toHaveLength(1);
	});

	it("uses the centered collapsed rail with search inside navigation", () => {
		const container = sidebar(true, "/repos/octocat/hello-world");
		expect(container.querySelector("aside")?.getAttribute("data-collapsed")).toBe("");
		const nav = container.querySelector("nav");
		const search = nav?.querySelector('[data-slot="sidebar-search"]');
		expect(search?.getAttribute("aria-label") ?? search?.textContent).toContain("搜索");
		const current = nav?.querySelector('[aria-current="page"]');
		expect(current?.getAttribute("aria-label") ?? current?.textContent?.trim()).toBe("仓库");
		const rows = nav?.querySelectorAll("button,a[data-sidebar-row]") ?? [];
		expect(
			Array.from(rows, (node) => node.getAttribute("aria-label") ?? node.textContent?.trim()),
		).toEqual(["搜索 (⌘K)", ...NAV_ITEMS.map((item) => item.label)]);
	});

	it("wires Cloudflare Access sign-out on the expanded footer", () => {
		const signOut = sidebar().querySelector('[data-slot="sidebar-user-sign-out"]');
		expect(signOut?.getAttribute("href")).toBe("/cdn-cgi/access/logout");
		expect(signOut?.getAttribute("aria-label")).toBe("退出登录");
	});
});
