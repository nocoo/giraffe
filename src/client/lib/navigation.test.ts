import { describe, expect, it } from "vitest";
import { breadcrumbsFor, NAV_ITEMS, paletteItems } from "./navigation";
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
		expect(paletteItems(null).map((item) => item.href)).toEqual(NAV_ITEMS.map((item) => item.href));
		expect(
			paletteItems([
				{ name_with_owner: "octocat/hello-world", owner_login: "octocat", name: "hello-world" },
			]).map((item) => item.href),
		).toContain("/repos/octocat/hello-world");
	});
});
