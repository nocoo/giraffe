import { describe, expect, it } from "vitest";
import { sanitize } from "./sanitize";

describe("sanitize", () => {
	it("strips classic PATs, fine-grained PATs, bearer headers, and envelopes", () => {
		const pat = `ghp_${"a".repeat(36)}`;
		expect(sanitize(`token ${pat}`)).toBe("token [redacted]");
		expect(sanitize("github_pat_11AAAA")).toBe("[redacted]");
		expect(sanitize("Authorization Bearer abc.def")).toBe("Authorization Bearer [redacted]");
		expect(sanitize('{"v":1,"iv":"aa","ct":"bb","tag":"cc"}')).toBe("[redacted]");
	});
});
