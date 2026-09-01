import { describe, expect, it } from "vitest";
import { API_ROUTE_PATTERN, hasApiRoutes } from "./has-api-routes";

describe("hasApiRoutes", () => {
	it("is false before any /api handler exists", async () => {
		expect(await hasApiRoutes()).toBe(false);
	});

	it("matches quoted paths and hono helpers", () => {
		expect(API_ROUTE_PATTERN.test('app.get("/api/live")')).toBe(true);
		expect(API_ROUTE_PATTERN.test("app.basePath('/api')")).toBe(true);
		expect(API_ROUTE_PATTERN.test('app.route("/api", router)')).toBe(true);
		expect(API_ROUTE_PATTERN.test("const path = '/health'")).toBe(false);
	});
});
