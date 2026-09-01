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
	});
});
