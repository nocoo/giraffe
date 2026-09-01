import { describe, expect, it } from "vitest";
import {
	activateStmt,
	countAccounts,
	deactivateAllStmt,
	deleteAccountStmt,
	getAccount,
	getAccountByLogin,
	getActiveAccount,
	insertAccountStmt,
	listAccounts,
	touchLastUsedStmt,
	upsertAccountStmt,
} from "./accounts";
import { createDb } from "./d1";
import { openSqliteD1 } from "./sqlite-d1";

function row(id: string, login: string, active: number) {
	return {
		id,
		login,
		avatar_url: "",
		token_ciphertext: "{}",
		token_last4: "AAAA",
		key_version: 1,
		scopes: "repo",
		capabilities: "{}",
		is_active: active,
		created_at: "t",
		updated_at: "t",
		last_used_at: null,
	};
}

describe("accounts store", () => {
	it("inserts, lists, activates in one batch, and deletes", async () => {
		const db = createDb(openSqliteD1());
		await db.batch([insertAccountStmt(db, row("1", "octo", 1))]);
		expect(await countAccounts(db)).toBe(1);
		expect((await getAccount(db, "1"))?.login).toBe("octo");
		expect((await getAccountByLogin(db, "octo"))?.id).toBe("1");
		expect((await getActiveAccount(db))?.id).toBe("1");
		await db.batch([insertAccountStmt(db, row("2", "hub", 0))]);
		await db.batch([deactivateAllStmt(db), activateStmt(db, "2", "u")]);
		expect((await getActiveAccount(db))?.id).toBe("2");
		await db.batch([
			upsertAccountStmt(db, { ...row("2", "hub", 1), token_last4: "BBBB", updated_at: "u2" }),
			touchLastUsedStmt(db, "2", "now"),
		]);
		expect((await listAccounts(db))[0]?.login).toBe("hub");
		await db.batch([deleteAccountStmt(db, "2")]);
		expect(await getAccount(db, "2")).toBeNull();
	});
});
