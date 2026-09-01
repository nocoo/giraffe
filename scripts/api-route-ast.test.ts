import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import { sourceHasApiRoutes } from "./api-route-ast";

function hasApi(code: string): boolean {
	return sourceHasApiRoutes(parseSync("x.ts", code).program);
}

describe("sourceHasApiRoutes", () => {
	it("matches quoted /api paths", () => {
		expect(hasApi('app.get("/api/live")')).toBe(true);
	});

	it("matches basePath and route", () => {
		expect(hasApi('app.basePath("/api")')).toBe(true);
		expect(hasApi('app.route("/api", router)')).toBe(true);
	});

	it("matches imported prefix variables", () => {
		expect(hasApi('const prefix = "/api"; app.route(prefix, r)')).toBe(true);
	});

	it("ignores unrelated paths", () => {
		expect(hasApi("app.get('/health')")).toBe(false);
	});
});
