// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
	breadcrumbsFor,
	headerCrumbs,
	headerTitle,
	NAV_GROUPS,
	NAV_ITEMS,
	paletteItems,
} from "./navigation";
import { APP_PATHS } from "./routes";

describe("navigation", () => {
	it("covers 01 section 9 paths and breadcrumbs", () => {
		expect(NAV_ITEMS.map((item) => item.href)).toEqual([
			"/",
			"/issues",
			"/pulls",
			"/insights",
			"/alerts",
			"/inbox",
			"/digest",
			"/settings",
		]);
		expect(NAV_GROUPS.map((group) => group.label)).toEqual(["浏览", "工作", "系统"]);
		expect(NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href))).toEqual(
			NAV_ITEMS.map((item) => item.href),
		);
		expect([...APP_PATHS]).toEqual([
			"/",
			"/issues",
			"/pulls",
			"/insights",
			"/alerts",
			"/inbox",
			"/digest",
			"/repos/:owner/:name",
			"/settings",
		]);
		expect(breadcrumbsFor("/")).toEqual([{ href: "/", label: "仓库" }]);
		expect(breadcrumbsFor("/repos/o/n")).toEqual([
			{ href: "/", label: "仓库" },
			{ href: "/repos/o/n", label: "o/n" },
		]);
		expect(breadcrumbsFor("/settings")).toEqual([{ href: "/settings", label: "设置" }]);
		expect(breadcrumbsFor("/nope")).toEqual([{ href: "/nope", label: "未找到" }]);
		expect(headerTitle("/")).toBe("仓库");
		expect(headerCrumbs("/")).toEqual([]);
		expect(headerTitle("/repos/o/n")).toBe("o/n");
		expect(headerCrumbs("/repos/o/n")).toEqual([{ href: "/", label: "仓库" }]);
		expect(paletteItems(null).map((item) => item.href)).toEqual(NAV_ITEMS.map((item) => item.href));
		expect(paletteItems(null)[0]?.icon).toBe("Box");
		expect(
			paletteItems([
				{ name_with_owner: "octocat/hello-world", owner_login: "octocat", name: "hello-world" },
			]).map((item) => item.href),
		).toContain("/repos/octocat/hello-world");
	});
});
