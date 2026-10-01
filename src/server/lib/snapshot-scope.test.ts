import { expect, it } from "vitest";
import { sqliteFixture } from "../../../tests/fixtures/sqlite";
import { createDb } from "./db/d1";
import { snapshotScope, snapshotSelection } from "./snapshot-scope";

it("defaults omitted scope to all and rejects every invalid explicit value", () => {
	expect(snapshotScope(undefined)).toBe("all");
	expect(snapshotScope("all")).toBe("all");
	expect(snapshotScope("starred")).toBe("starred");
	expect(snapshotScope(["starred"])).toBe("starred");
	for (const values of [[], ["all", "starred"], ["starred", "starred"]])
		expect(() => snapshotScope(values)).toThrow(expect.objectContaining({ status: 400 }));
	for (const value of ["", "ALL", "selected", "all,starred", " starred"])
		expect(() => snapshotScope(value)).toThrow(expect.objectContaining({ status: 400 }));
});

it("selects stars case-insensitively within one account and never broadens an empty set", async () => {
	const db = createDb(sqliteFixture());
	for (const account of ["active", "other"])
		await db
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?, 'encrypted','fake','t','t')",
			)
			.bind(account, account)
			.run();
	await db.prepare("INSERT INTO repo_stars VALUES('active','Owner/App')").run();
	await db.prepare("INSERT INTO repo_stars VALUES('other','owner/hidden')").run();
	const starred = await snapshotSelection(db, "active", "starred");
	expect(starred.includes("OWNER/APP")).toBe(true);
	expect(starred.starred("owner/app")).toBe(true);
	expect(starred.includes("owner/hidden")).toBe(false);
	const all = await snapshotSelection(db, "active", "all");
	expect(all.includes("owner/hidden")).toBe(true);
	expect(all.starred("owner/hidden")).toBe(false);
	expect((await snapshotSelection(db, "missing", "starred")).includes("owner/app")).toBe(false);
});
