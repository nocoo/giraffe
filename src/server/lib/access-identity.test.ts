import { describe, expect, it } from "vitest";
import { identityFromClaims } from "./access-identity";

describe("identityFromClaims", () => {
	it("falls back name to email and rejects missing email", () => {
		expect(identityFromClaims("a@b.c", undefined)).toEqual({ email: "a@b.c", name: "a@b.c" });
		expect(() => identityFromClaims(undefined, "n")).toThrow();
	});
});
