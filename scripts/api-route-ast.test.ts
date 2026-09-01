import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import { exportedApiBindings, sourceHasApiRoutes } from "./api-route-ast";

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

	it("matches concatenated prefixes", () => {
		expect(hasApi('const prefix = "/" + "api"; app.route(prefix, r)')).toBe(true);
	});

	it("matches extra imported aliases", () => {
		const program = parseSync("x.ts", "app.route(API_ROOT, r)").program;
		expect(sourceHasApiRoutes(program, new Set(["API_ROOT"]))).toBe(true);
	});

	it("collects exported /api bindings", () => {
		const program = parseSync("x.ts", 'export const API_ROOT = "/api"').program;
		expect(exportedApiBindings(program).get("API_ROOT")).toBe("/api");
	});

	it("ignores unrelated paths", () => {
		expect(hasApi("app.get('/health')")).toBe(false);
	});
});
