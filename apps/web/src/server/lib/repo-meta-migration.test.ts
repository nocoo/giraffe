import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

it("R6 additive migration preserves a marked backup, prior state and snapshots without duplicate catalog timestamps", () => {
	const migration = readFileSync("migrations/0024_repo_meta.sql", "utf8");
	const schema = readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8");
	expect(schema).toContain(migration);
	const directory = mkdtempSync(join(tmpdir(), "giraffe-meta-"));
	const file = join(directory, "original.sqlite");
	const original = new DatabaseSync(file);
	try {
		original.exec(schema.slice(0, schema.indexOf(migration)));
		original.exec(
			"PRAGMA foreign_keys=ON; CREATE TABLE _test_marker(key TEXT PRIMARY KEY,value TEXT); INSERT INTO _test_marker VALUES('env','test'); INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t'); INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES('a','repos','{\"repos\":[]}','t'); INSERT INTO repo_agent_state VALUES('a','R_app','{}',1,'t','fixture');",
		);
		const snapshots = original.prepare("SELECT * FROM snapshots").all();
		const state = original.prepare("SELECT * FROM repo_agent_state").all();
		original.close();
		const backupFile = join(directory, "backup.sqlite");
		copyFileSync(file, backupFile);
		const bytes = readFileSync(file);
		const backup = new DatabaseSync(backupFile);
		try {
			expect(backup.prepare("SELECT value FROM _test_marker WHERE key='env'").get()).toEqual({
				value: "test",
			});
			backup.exec("PRAGMA foreign_keys=ON");
			backup.exec(migration);
			backup.exec(migration);
			expect(backup.prepare("SELECT * FROM snapshots").all()).toEqual(snapshots);
			expect(backup.prepare("SELECT * FROM repo_agent_state").all()).toEqual(state);
			const names = backup
				.prepare("PRAGMA table_info(repo_meta)")
				.all()
				.map((row) => row.name);
			expect(names).not.toContain("first_seen_at");
			expect(names).not.toContain("deleted_at");
			backup.exec(
				"INSERT INTO repo_meta(account_id,identity_key,category,category_source,updated_at) VALUES('a','R_app','app','agent','t')",
			);
			expect(() => backup.exec("UPDATE repo_meta SET category='unknown'")).toThrow();
			expect(() => backup.exec("UPDATE repo_meta SET category_source='unknown'")).toThrow();
			expect(backup.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			backup.exec("DELETE FROM accounts WHERE id='a'");
			expect(backup.prepare("SELECT * FROM repo_meta").all()).toEqual([]);
		} finally {
			backup.close();
		}
		expect(readFileSync(file)).toEqual(bytes);
	} finally {
		if (original.isOpen) original.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
