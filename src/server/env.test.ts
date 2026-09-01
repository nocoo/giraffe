import { describe, expect, it } from "vitest";
import type { Env } from "./env";
import { currentKeyVersion, encryptionKey, envMode } from "./env";

function env(partial: Partial<Env> & { TOKEN_ENCRYPTION_KEY_V1?: string }): Env {
	return {
		DB: {} as D1Database,
		ASSETS: { fetch: () => Promise.reject(new Error("no assets")) } as unknown as Fetcher,
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
		...partial,
	};
}

describe("envMode", () => {
	it("maps development test and everything else to production", () => {
		expect(envMode("development")).toBe("development");
		expect(envMode("test")).toBe("test");
		expect(envMode(undefined)).toBe("production");
		expect(envMode("production")).toBe("production");
		expect(envMode("staging")).toBe("production");
	});
});

describe("encryptionKey", () => {
	it("reads TOKEN_ENCRYPTION_KEY_V<n> without a wide Env index", () => {
		const e = env({ TOKEN_ENCRYPTION_KEY_V1: "abc" });
		expect(encryptionKey(e, 1)).toBe("abc");
		expect(encryptionKey(e, 2)).toBeUndefined();
		expect(encryptionKey(e, Number.NaN)).toBeUndefined();
	});

	it("parses the current key version", () => {
		expect(currentKeyVersion(env({ TOKEN_ENCRYPTION_KEY_CURRENT: "3" }))).toBe(3);
		expect(Number.isNaN(currentKeyVersion(env({ TOKEN_ENCRYPTION_KEY_CURRENT: "x" })))).toBe(true);
		expect(Number.isNaN(currentKeyVersion(env({ TOKEN_ENCRYPTION_KEY_CURRENT: "1oops" })))).toBe(
			true,
		);
	});
});
