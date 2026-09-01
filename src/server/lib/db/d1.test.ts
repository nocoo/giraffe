import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import { createDb } from "./d1";
import { openSqliteD1 } from "./sqlite-d1";

describe("createDb", () => {
	it("counts statements and rejects the 81st before execute", async () => {
		const db = createDb(openSqliteD1());
		for (let i = 0; i < 80; i += 1) {
			await db.prepare("SELECT 1 AS n").first();
		}
		expect(db.statements).toBe(80);
		await expect(db.prepare("SELECT 1 AS n").first()).rejects.toBeInstanceOf(ApiError);
		const other = createDb(openSqliteD1());
		expect(other.statements).toBe(0);
		await other.prepare("SELECT 1 AS n").bind().first();
		expect(other.statements).toBe(1);
		expect(await other.prepare("SELECT 1 AS n").first("n")).toBe(1);
		expect(
			await other.prepare("SELECT * FROM accounts WHERE id = ?").bind("missing").first("id"),
		).toBeNull();
		await expect(other.prepare("NOPE").first()).rejects.toThrow(/unsupported sql/);
	});
});
