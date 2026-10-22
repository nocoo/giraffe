import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

it("R4 migrates a marked backup without inventing activity and enforces UTF-8 page caps", () => {
	const migration = readFileSync("migrations/0018_activity.sql", "utf8");
	const schema = readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8");
	expect(schema).toContain(migration);
	const directory = mkdtempSync(join(tmpdir(), "giraffe-activity-migration-"));
	const originalFile = join(directory, "original.sqlite");
	const backupFile = join(directory, "backup.sqlite");
	const original = new DatabaseSync(originalFile);
	try {
		original.exec(schema.slice(0, schema.indexOf(migration)));
		original.exec(`CREATE TABLE _test_marker(key TEXT PRIMARY KEY,value TEXT);
INSERT INTO _test_marker VALUES('env','test');
INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','2026-10-21','2026-10-21');
INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES('a','repos','{"repos":[]}','2026-10-21');
INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('r','a','key','completed','{}','2026-10-21','2026-10-21','2026-10-21');`);
		const before = original.prepare("SELECT * FROM snapshots").all();
		original.close();
		copyFileSync(originalFile, backupFile);
		const originalBytes = readFileSync(originalFile);
		const backup = new DatabaseSync(backupFile);
		try {
			backup.exec("PRAGMA foreign_keys=ON");
			expect(backup.prepare("SELECT value FROM _test_marker WHERE key='env'").get()).toEqual({
				value: "test",
			});
			backup.exec(migration);
			backup.exec(migration);
			expect(backup.prepare("SELECT * FROM snapshots").all()).toEqual(before);
			expect(backup.prepare("SELECT * FROM activity_publications").all()).toEqual([]);
			expect(backup.prepare("SELECT * FROM activity_pages").all()).toEqual([]);
			const exact = JSON.stringify(`${"界".repeat(499_999)}x`);
			expect(Buffer.byteLength(exact)).toBe(1_500_000);
			backup
				.prepare(
					"INSERT INTO activity_publications(account_id,run_id,until_at,fetched_at,payload,content_version) VALUES('a','r','2026-10-21','2026-10-21',?,'fixture')",
				)
				.run(exact);
			backup
				.prepare("INSERT INTO activity_pages(account_id,run_id,page,payload) VALUES('a','r',0,?)")
				.run(exact);
			expect(() =>
				backup
					.prepare("UPDATE activity_publications SET payload=? WHERE account_id='a'")
					.run(`${exact} `),
			).toThrow();
			expect(() =>
				backup.prepare("UPDATE activity_pages SET payload=? WHERE account_id='a'").run(`${exact} `),
			).toThrow();
			expect(() =>
				backup.prepare("INSERT INTO activity_pages VALUES('a','r',16,'[]')").run(),
			).toThrow();
			expect(backup.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			backup.exec("DELETE FROM accounts WHERE id='a'");
			expect(backup.prepare("SELECT * FROM activity_publications").all()).toEqual([]);
			expect(backup.prepare("SELECT * FROM activity_pages").all()).toEqual([]);
		} finally {
			backup.close();
		}
		expect(readFileSync(originalFile)).toEqual(originalBytes);
	} finally {
		if (original.isOpen) original.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
