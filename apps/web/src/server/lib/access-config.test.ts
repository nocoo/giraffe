import { describe, expect, it } from "vitest";
import { ACCESS_AUD, ACCESS_TEAM_DOMAIN } from "./access-config";

describe("access-config", () => {
	it("pins the production Access audience and team", () => {
		expect(ACCESS_TEAM_DOMAIN).toBe("https://nocoo.cloudflareaccess.com");
		expect(ACCESS_AUD).toBe("708cd6083298fe4ff68440b542fb1d440f5c5fcd399b17f6f44a21cb4d4cf2c6");
	});
});
