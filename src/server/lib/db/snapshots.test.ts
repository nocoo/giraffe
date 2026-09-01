import { describe, expect, it } from "vitest";
import { insertAccountStmt } from "./accounts";
import { createDb } from "./d1";
import { pruneDaysStmt, readDay, upsertDayStmt } from "./snapshot-days";
import { readSnapshot, replaceSnapshotStmts } from "./snapshots";
import { openSqliteD1 } from "./sqlite-d1";

describe("snapshots store", () => {
	it("replaces pages in two statements and reads them back", async () => {
		const db = createDb(openSqliteD1());
		await db.batch([
			insertAccountStmt(db, {
				id: "1",
				login: "o",
				avatar_url: "",
				token_ciphertext: "{}",
				token_last4: "AAAA",
				key_version: 1,
				scopes: "",
				capabilities: "{}",
				is_active: 1,
				created_at: "t",
				updated_at: "t",
				last_used_at: null,
			}),
		]);
		await db.batch(
			replaceSnapshotStmts(
				db,
				"1",
				"repos",
				{ truncated: false, repos: [{ n: 1 }] },
				"2026-09-01T00:00:00.000Z",
			),
		);
		const snap = await readSnapshot(db, "1", "repos");
		expect(snap?.repos).toEqual([{ n: 1 }]);
		expect(await readSnapshot(db, "1", "issues")).toBeNull();
		await db.batch([
			upsertDayStmt(db, "1", "2026-09-01", {
				stars: 1,
				forks: 0,
				open_issues: 0,
				repos: 1,
				by_repo: [{ name_with_owner: "o/n", stars: 1, forks: 0, open_issues: 0 }],
			}),
			pruneDaysStmt(db, "1", "2026-08-01"),
		]);
		expect((await readDay(db, "1", "2026-09-01"))?.stars).toBe(1);
		expect(await readDay(db, "1", "2026-08-01")).toBeNull();
	});
});
