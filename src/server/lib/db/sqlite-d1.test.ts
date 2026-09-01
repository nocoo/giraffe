import { describe, expect, it } from "vitest";
import { openSqliteD1 } from "./sqlite-d1";

describe("openSqliteD1", () => {
	it("optionally creates the test marker", async () => {
		const db = openSqliteD1(true);
		const row = await db
			.prepare("SELECT value FROM _test_marker WHERE key = ?")
			.bind("env")
			.first<{ value: string }>();
		expect(row?.value).toBe("test");
		expect(await db.dump()).toBe("");
		expect((await db.exec("SELECT 1")).count).toBe(0);
		const rolling = openSqliteD1();
		await rolling
			.prepare(
				"INSERT INTO accounts (id, login, avatar_url, token_ciphertext, token_last4, key_version, scopes, capabilities, is_active, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.bind("1", "octo", "", "{}", "AAAA", 1, "", "{}", 1, "t", "t", null)
			.run();
		expect(
			(await rolling.prepare("SELECT COUNT(*) AS n FROM accounts").first<{ n: number }>())?.n,
		).toBe(1);
		const insert = rolling
			.prepare(
				"INSERT INTO accounts (id, login, avatar_url, token_ciphertext, token_last4, key_version, scopes, capabilities, is_active, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.bind("2", "hub", "", "{}", "BBBB", 1, "", "{}", 0, "t", "t", null);
		const boom = {
			run: async () => {
				throw new Error("fail");
			},
		} as unknown as D1PreparedStatement;
		await expect(rolling.batch([insert, boom])).rejects.toThrow("fail");
		expect(
			(await rolling.prepare("SELECT COUNT(*) AS n FROM accounts").first<{ n: number }>())?.n,
		).toBe(1);
	});
});
