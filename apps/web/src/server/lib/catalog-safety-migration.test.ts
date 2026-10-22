import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

const migration = readFileSync("migrations/0020_catalog_identity_safety.sql", "utf8");
const previous = readFileSync("migrations/0019_catalog_history.sql", "utf8");
const schema = readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8");
const oldSchema = schema.slice(0, schema.indexOf(migration));
const account =
	"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','nocoo','fake','fake','old','old');";
const repository =
	"INSERT INTO catalog_repositories(account_id,identity_key,github_id,repo,row_payload,first_seen_at,last_seen_at,is_archived,visibility,is_fork,first_seen_source) VALUES('a','R_OLD','R_OLD','nocoo/old','{\"name_with_owner\":\"nocoo/old\"}','2026-10-21','2026-10-21',0,'PUBLIC',0,'github_catalog');";

it("R7 safety migration preserves old catalog rows and permits 0019 replay with a displaced unconfirmed namesake", () => {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(`PRAGMA foreign_keys=ON;${oldSchema}${account}${repository}`);
		const old = db.prepare("SELECT * FROM catalog_repositories").get();
		db.exec(migration);
		expect(db.prepare("SELECT * FROM catalog_repositories").get()).toEqual({
			...old,
			name_current: 1,
		});
		db.exec(
			"UPDATE catalog_repositories SET name_current=0;INSERT INTO catalog_repositories SELECT account_id,'R_NEW','R_NEW',repo,row_payload,first_seen_at,last_seen_at,removed_at,archived_changed_at,is_archived,visibility,is_fork,first_seen_source,last_source_run_id,1 FROM catalog_repositories;",
		);
		db.exec(
			"INSERT INTO catalog_displaced_state VALUES('a','R_OLD','factory_repo_state','nocoo/old','version','{\"repo\":\"nocoo/old\"}');INSERT INTO catalog_unconfirmed VALUES('a','pending','nocoo/old','R_OLD','2026-10-22','legacy',NULL,'lookup_unverifiable');",
		);
		const saved = ["catalog_repositories", "catalog_displaced_state", "catalog_unconfirmed"].map(
			(table) => db.prepare(`SELECT * FROM ${table}`).all(),
		);
		expect(() => db.exec(previous)).not.toThrow();
		expect(
			["catalog_repositories", "catalog_displaced_state", "catalog_unconfirmed"].map((table) =>
				db.prepare(`SELECT * FROM ${table}`).all(),
			),
		).toEqual(saved);
		expect(
			db.prepare("SELECT removed_at FROM catalog_repositories WHERE identity_key='R_OLD'").get(),
		).toEqual({ removed_at: null });
		expect(() =>
			db.exec("UPDATE catalog_repositories SET name_current=1 WHERE identity_key='R_OLD'"),
		).toThrow();
		expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		db.exec("DELETE FROM accounts WHERE id='a'");
		for (const table of ["catalog_repositories", "catalog_displaced_state", "catalog_unconfirmed"])
			expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
	} finally {
		db.close();
	}
});

it("R7 safety quarantine accepts the exact raw state byte cap and rejects overflow atomically", () => {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(`${schema}${account}${repository}`);
		const exact = JSON.stringify({
			repo: "nocoo/old",
			value: "x".repeat(1500000 - JSON.stringify({ repo: "nocoo/old", value: "" }).length),
		});
		expect(Buffer.byteLength(exact)).toBe(1500000);
		db.prepare(
			"INSERT INTO catalog_displaced_state VALUES('a','R_OLD','factory_repo_state','nocoo/old','v',?)",
		).run(exact);
		expect(() =>
			db.prepare("UPDATE catalog_displaced_state SET payload=?").run(`${exact} `),
		).toThrow();
		expect(db.prepare("SELECT payload FROM catalog_displaced_state").get()).toEqual({
			payload: exact,
		});
	} finally {
		db.close();
	}
});

it("R7 safety verifier accepts complete old/new exports and rejects every partial new schema", () => {
	const directory = mkdtempSync(join(tmpdir(), "giraffe-catalog-safety-"));
	try {
		const file = join(directory, "backup.sql");
		for (const initial of [oldSchema, schema]) {
			writeFileSync(file, `${initial}${account}${repository}`);
			expect(
				JSON.parse(
					execFileSync("bun", ["scripts/verify-factory-migration.ts", file], { encoding: "utf8" }),
				),
			).toMatchObject({ applied: 2, legacyTablesUnchanged: true, rollbackVerified: true });
		}
		for (const partial of [
			`${oldSchema}ALTER TABLE catalog_repositories ADD COLUMN name_current INTEGER NOT NULL DEFAULT 1;`,
			`${oldSchema}CREATE TABLE catalog_unconfirmed(account_id TEXT);`,
			schema.replace(
				"CREATE INDEX IF NOT EXISTS catalog_unconfirmed_cursor ON catalog_unconfirmed(account_id,at,repo,event_id);",
				"",
			),
			schema.replace(
				"FOREIGN KEY(account_id,identity_key) REFERENCES catalog_repositories(account_id,identity_key) ON DELETE CASCADE",
				"FOREIGN KEY(account_id,identity_key) REFERENCES catalog_repositories(account_id,identity_key)",
			),
		]) {
			writeFileSync(file, `${partial}${account}${repository}`);
			expect(() =>
				execFileSync("bun", ["scripts/verify-factory-migration.ts", file], {
					encoding: "utf8",
					stdio: "pipe",
				}),
			).toThrow(/Partial catalog identity safety migration/);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
