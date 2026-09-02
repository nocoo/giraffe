// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { displayName, loadMe } from "./me";

describe("me viewmodel", () => {
	afterEach(() => {
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("maps access identity and falls back to email", async () => {
		expect(displayName({ email: "dev@local", name: "dev" })).toBe("dev");
		expect(displayName({ email: "a@b.c", name: "  " })).toBe("a@b.c");
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			expect(String(input)).toBe("/api/me");
			return Response.json({ email: "dev@local", name: "dev" });
		});
		expect(await loadMe()).toEqual({ email: "dev@local", name: "dev" });
	});
});
