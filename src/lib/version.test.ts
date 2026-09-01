import { describe, expect, it } from "vitest";
import { APP_VERSION } from "./version";

describe("APP_VERSION", () => {
	it("matches package.json", () => {
		expect(APP_VERSION).toBe("0.0.0");
	});
});
