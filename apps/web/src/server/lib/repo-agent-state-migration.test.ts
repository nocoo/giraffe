import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

it("R5 additive migration preserves a marked backup and enforces object/UTF-8/revision constraints", () => {
	const migration = readFileSync("migrations/0023_repo_agent_state.sql", "utf8");
	const schema = readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8");
	expect(schema).toContain(migration);
	const directory = mkdtempSync(join(tmpdir(), "giraffe-agent-state-"));
	const originalFile = join(directory, "original.sqlite");
	const backupFile = join(directory, "backup.sqlite");
	const original = new DatabaseSync(originalFile);
	try {
		original.exec(schema.slice(0, schema.indexOf(migration)));
		original.exec(
			"CREATE TABLE _test_marker(key TEXT PRIMARY KEY,value TEXT); INSERT INTO _test_marker VALUES('env','test'); INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t'); INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES('a','repos','{\"repos\":[]}','t');",
		);
		const snapshots = original.prepare("SELECT * FROM snapshots").all();
		original.close();
		copyFileSync(originalFile, backupFile);
		const bytes = readFileSync(originalFile);
		const backup = new DatabaseSync(backupFile);
		try {
			backup.exec("PRAGMA foreign_keys=ON");
			expect(backup.prepare("SELECT value FROM _test_marker WHERE key='env'").get()).toEqual({
				value: "test",
			});
			backup.exec(migration);
			backup.exec(migration);
			expect(backup.prepare("SELECT * FROM snapshots").all()).toEqual(snapshots);
			const insert = backup.prepare("INSERT INTO repo_agent_state VALUES('a',?, ?,1,'t','token')");
			const exact = JSON.stringify({ x: `${"界".repeat(5458)}xx` });
			expect(Buffer.byteLength(exact)).toBe(16384);
			insert.run("identity", exact);
			for (const payload of [
				"[]",
				"null",
				"not-json",
				JSON.stringify({ x: `${"界".repeat(5458)}xxx` }),
			])
				expect(() => insert.run("invalid", payload)).toThrow();
			expect(() => backup.prepare("UPDATE repo_agent_state SET revision=0").run()).toThrow();
			expect(backup.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			backup.exec("DELETE FROM accounts WHERE id='a'");
			expect(backup.prepare("SELECT * FROM repo_agent_state").all()).toEqual([]);
		} finally {
			backup.close();
		}
		expect(readFileSync(originalFile)).toEqual(bytes);
	} finally {
		if (original.isOpen) original.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
