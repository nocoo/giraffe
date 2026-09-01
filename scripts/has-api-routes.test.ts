import { describe, expect, it } from "vitest";
import { hasApiRoutes } from "./has-api-routes";

describe("hasApiRoutes", () => {
	it("is false before any /api handler exists", async () => {
		expect(await hasApiRoutes()).toBe(false);
	});
});
