import { expect, it } from "vitest";
import { configSchema } from "./config.ts";
import { safeDiagnostics } from "./diagnostics.ts";
import { githubRead } from "./github.ts";
import { cronStatusSchema, workRunSchema } from "./work-contracts.ts";

it("keeps diagnostic credentials out of bounded persisted progress", () => {
	const output = safeDiagnostics(
		`-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\nAuthorization: Bearer private\nCookie: private\napi_key="private"\nhttps://user:pass@example.com\nghp_abcdefghijklmnopqrstuvw\neyJab.cd.ef\n\u0000${"z".repeat(5000)}\n${"汉".repeat(1000)}`,
	);
	expect(output).not.toContain("secret");
	expect(output).not.toContain("private");
	expect(Buffer.byteLength(output)).toBeLessThanOrEqual(2048);
	expect(safeDiagnostics("ok\tgood")).toBe("ok\tgood");
	expect(safeDiagnostics("-----BEGIN PRIVATE KEY-----\nsecret")).toBe("[redacted]");
	expect(
		safeDiagnostics("password='private'\nsecret=private\nProxy-Authorization: private"),
	).not.toContain("private");
});

it("rejects unsafe live read paths and old schedules", async () => {
	await expect(githubRead("../user")).rejects.toThrow("Invalid GitHub read path");
	expect(configSchema.safeParse({ watch: {}, repairs: {} }).success).toBe(false);
	expect(
		workRunSchema.safeParse({ occurrence: "one", events: [], updatedAt: "2026-10-03T00:00:00Z" })
			.success,
	).toBe(true);
	expect(cronStatusSchema.safeParse({}).success).toBe(false);
});
