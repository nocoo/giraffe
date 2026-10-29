import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

it("adds empty refresh storage twice on a marked backup without importing or changing legacy evidence", () => {
	const observations = readFileSync("migrations/0028_refresh_observations.sql", "utf8");
	const runs = readFileSync("migrations/0029_refresh_runs.sql", "utf8");
	const schema = readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8");
	const directory = mkdtempSync(join(tmpdir(), "giraffe-refresh-migration-"));
	const original = join(directory, "original.sqlite");
	const backup = join(directory, "backup.sqlite");
	const source = new DatabaseSync(original);
	try {
		source.exec(schema.slice(0, schema.indexOf(observations)));
		source.exec(
			"CREATE TABLE _test_marker(key TEXT PRIMARY KEY,value TEXT); INSERT INTO _test_marker VALUES('env','test')",
		);
		source.exec(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('account','owner','fake','fake','old','old')",
		);
		source.exec(
			"INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES('account','repos','{\"repos\":[{\"id\":\"old\"}]}','old')",
		);
	} finally {
		source.close();
	}
	copyFileSync(original, backup);
	const database = new DatabaseSync(backup);
	try {
		database.exec("PRAGMA foreign_keys=ON");
		expect(database.prepare("SELECT value FROM _test_marker WHERE key='env'").get()).toEqual({
			value: "test",
		});
		const before = database.prepare("SELECT * FROM snapshots").all();
		for (let pass = 0; pass < 2; pass++) database.exec(`${observations}\n${runs}`);
		expect(database.prepare("SELECT * FROM snapshots").all()).toEqual(before);
		const tables = database
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'refresh_%' ORDER BY name",
			)
			.all() as { name: string }[];
		expect(tables.map(({ name }) => name)).toEqual([
			"refresh_accounts",
			"refresh_catalog",
			"refresh_day_observations",
			"refresh_items",
			"refresh_publications",
			"refresh_repository_publications",
			"refresh_resources",
			"refresh_runs",
			"refresh_schedule_times",
			"refresh_schedules",
			"refresh_snapshots",
		]);
		for (const { name } of tables)
			expect(database.prepare(`SELECT * FROM ${name}`).all()).toEqual([]);
		const catalog = database.prepare(
			"INSERT INTO refresh_catalog(account_id,repo_id,repo,discovered_day,timezone,payload,fetched_at) VALUES('account',?,'Owner/App','2026-10-29','Asia/Shanghai','{}','now')",
		);
		catalog.run("new");
		expect(() => catalog.run("replacement")).toThrow();
		database.exec("UPDATE refresh_catalog SET active=0");
		catalog.run("replacement");
		const insertRun = database.prepare(
			"INSERT INTO refresh_runs(id,account_id,status,trigger,schedule_day,payload,created_at,updated_at) VALUES(?,'account',?,?,?,'{}','now','now')",
		);
		insertRun.run("first", "running", "manual", null);
		expect(() => insertRun.run("parallel", "running", "manual", null)).toThrow();
		insertRun.run("daily", "queued", "scheduled", "2026-10-29");
		expect(() => insertRun.run("duplicate", "queued", "scheduled", "2026-10-29")).toThrow();
		expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
		database.exec("DELETE FROM accounts WHERE id='account'");
		for (const { name } of tables)
			expect(database.prepare(`SELECT * FROM ${name}`).all()).toEqual([]);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
