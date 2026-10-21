import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

it("adds nullable metadata on a backup without backfilling or breaking old-column writes", () => {
	const migration = readFileSync("migrations/0014_source_content.sql", "utf8");
	const schema = readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8");
	expect(schema.endsWith(migration)).toBe(true);
	const oldSchema = schema.slice(0, -migration.length);
	const directory = mkdtempSync(join(tmpdir(), "giraffe-content-migration-"));
	const sourceFile = join(directory, "source.sqlite");
	const backupFile = join(directory, "backup.sqlite");
	const source = new DatabaseSync(sourceFile);
	const seed = `
CREATE TABLE _test_marker(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO _test_marker VALUES('env','test');
INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('legacy','legacy','fixture','fake','old','old');
INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES('legacy','repos','{"repos":[],"fetched_at":"old"}','old');
INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('run','legacy','run','completed','{}','old','old','old');
INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES('run','owner/repo','commits','{"runId":"run","items":[]}');
`;
	try {
		source.exec(oldSchema + seed);
		source.exec(`VACUUM INTO '${backupFile.replaceAll("'", "''")}'`);
		source.close();
		const originalBytes = readFileSync(sourceFile);
		const backup = new DatabaseSync(backupFile);
		try {
			const snapshots = () =>
				backup.prepare("SELECT account_id,kind,payload,fetched_at FROM snapshots").all();
			const resources = () =>
				backup.prepare("SELECT run_id,repo,stream,payload FROM factory_resources").all();
			const before = { snapshots: snapshots(), resources: resources() };
			backup.exec(migration);
			expect({ snapshots: snapshots(), resources: resources() }).toEqual(before);
			for (const table of ["snapshots", "factory_resources"])
				expect(backup.prepare(`SELECT content_meta FROM ${table}`).all()).toEqual([
					{ content_meta: null },
				]);
			backup.exec("UPDATE snapshots SET fetched_at='unchanged-content' WHERE account_id='legacy'");
			expect(backup.prepare("SELECT content_meta,payload FROM snapshots").get()).toEqual({
				content_meta: null,
				payload: '{"repos":[],"fetched_at":"old"}',
			});
			backup.exec(
				"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES('run','owner/repo','prs','{}')",
			);
			expect(
				backup.prepare("SELECT content_meta FROM factory_resources WHERE stream='prs'").get(),
			).toEqual({ content_meta: null });
			expect(backup.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
		} finally {
			backup.close();
		}
		expect(readFileSync(sourceFile)).toEqual(originalBytes);
		const exportFile = join(directory, "backup.sql");
		for (const initialSchema of [oldSchema, schema]) {
			writeFileSync(exportFile, initialSchema + seed);
			const result = JSON.parse(
				execFileSync("bun", ["scripts/verify-factory-migration.ts", exportFile], {
					encoding: "utf8",
				}),
			);
			expect(result).toMatchObject({
				applied: 2,
				legacyTablesUnchanged: true,
				operationalProbe: true,
				rollbackVerified: true,
			});
		}
	} finally {
		if (source.isOpen) source.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
