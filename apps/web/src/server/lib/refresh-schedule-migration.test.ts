import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

it("applies repeatably to a local backup without changing legacy rows and supports old-column rollback", () => {
	const migration = readFileSync("migrations/0013_refresh_schedule_times.sql", "utf8");
	const schema = readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8");
	expect(schema.endsWith(migration)).toBe(true);
	const oldSchema = schema.slice(0, -migration.length);
	const dir = mkdtempSync(join(tmpdir(), "giraffe-schedule-migration-"));
	const sourceFile = join(dir, "source.sqlite");
	const backupFile = join(dir, "backup.sqlite");
	const source = new DatabaseSync(sourceFile);
	const seed = `
CREATE TABLE _test_marker(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO _test_marker VALUES('env','test');
INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES('schedule-backup','schedule-backup','not-a-credential','fake',1,'2026','2026');
INSERT INTO snapshots VALUES('schedule-backup','repos','{"repos":[]}','2026-10-20T00:00:00Z');
INSERT INTO refresh_schedules VALUES('schedule-backup','daily',1,'19:30',0,'starred','2026-10-21T11:30:00Z','daily-run','scheduled_slots_missed');
INSERT INTO refresh_schedules VALUES('schedule-backup','weekly',1,'04:00',0,'all','2026-10-24T20:00:00Z','weekly-run',NULL);
INSERT INTO catalog_refresh_schedules VALUES('schedule-backup','catalog',0,'06:45',0,'all','2026-10-20T22:45:00Z',NULL,'catalog_pending');
`;
	try {
		source.exec(oldSchema + seed);
		source.exec(`VACUUM INTO '${backupFile.replaceAll("'", "''")}'`);
		source.close();
		const sourceBytes = readFileSync(sourceFile);
		const backup = new DatabaseSync(backupFile);
		try {
			backup.exec("PRAGMA foreign_keys=ON");
			const tables = backup
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all() as { name: string }[];
			const rows = () =>
				Object.fromEntries(
					tables.map(({ name }) => [
						name,
						backup.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),
					]),
				);
			const before = rows();
			backup.exec(migration);
			backup.exec(migration);
			expect(rows()).toEqual(before);
			expect(
				backup.prepare("SELECT kind,times FROM refresh_schedule_times ORDER BY kind").all(),
			).toEqual([
				{ kind: "catalog", times: '["06:45"]' },
				{ kind: "daily", times: '["19:30"]' },
				{ kind: "weekly", times: '["04:00"]' },
			]);
			backup.exec(`UPDATE refresh_schedule_times SET times='["19:30","23:00"]' WHERE kind='daily'`);
			backup.exec(migration);
			expect(
				backup.prepare("SELECT times FROM refresh_schedule_times WHERE kind='daily'").get(),
			).toEqual({ times: '["19:30","23:00"]' });
			for (const table of ["refresh_schedules", "catalog_refresh_schedules"]) {
				backup.exec(`UPDATE ${table} SET time='07:30' WHERE kind IN ('daily','catalog')`);
				expect(
					backup.prepare(`SELECT time FROM ${table} WHERE kind IN ('daily','catalog')`).get(),
				).toEqual({ time: "07:30" });
				expect(
					backup
						.prepare("SELECT times FROM refresh_schedule_times WHERE kind=?")
						.get(table === "refresh_schedules" ? "daily" : "catalog"),
				).toEqual({ times: '["07:30"]' });
				backup.exec(`DELETE FROM ${table} WHERE kind IN ('daily','catalog')`);
			}
			expect(backup.prepare("SELECT kind FROM refresh_schedule_times ORDER BY kind").all()).toEqual(
				[{ kind: "weekly" }],
			);
			backup.exec("UPDATE refresh_schedules SET time='04:00' WHERE kind='weekly'");
			expect(
				backup.prepare("SELECT times FROM refresh_schedule_times WHERE kind='weekly'").get(),
			).toEqual({ times: '["04:00"]' });
			expect(backup.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
		} finally {
			backup.close();
		}
		expect(readFileSync(sourceFile)).toEqual(sourceBytes);
		const exportFile = join(dir, "local-backup.sql");
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
				integrity: { integrity_check: "ok" },
			});
		}
	} finally {
		if (source.isOpen) source.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
