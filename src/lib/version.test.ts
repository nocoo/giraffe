import { describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import { APP_VERSION } from "./version";

describe("APP_VERSION", () => {
	it("matches package.json", () => {
		expect(APP_VERSION).toBe(pkg.version);
	});
});
