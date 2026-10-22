import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

const migration = readFileSync("migrations/0017_star_provenance.sql", "utf8");
const cleanup = readFileSync("migrations/0016_star_membership.sql", "utf8");
const schema = readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8");
const oldSchema = schema.slice(0, schema.indexOf(cleanup));
const seed = `
CREATE TABLE _test_marker(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO _test_marker VALUES('env','test');
INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','old','2026-10-21T12:34:56Z'),('b','other','fake','fake','old','invalid');
INSERT INTO repo_stars(account_id,repo) VALUES('a','Owner/App'),('a','owner/excluded'),('a','external/repo'),('b','other/app');
INSERT INTO repo_statistics VALUES('a','OWNER/EXCLUDED',0);
INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES('a','repos','{"repos":[]}','old');
`;

it("adds owner provenance on a backup, preserves R2 removals and old-column writes without rebuilding schema", () => {
	const directory = mkdtempSync(join(tmpdir(), "giraffe-star-provenance-"));
	const sourceFile = join(directory, "source.sqlite");
	const backupFile = join(directory, "backup.sqlite");
	const source = new DatabaseSync(sourceFile);
	try {
		source.exec(oldSchema + seed);
		expect(source.prepare("SELECT value FROM _test_marker WHERE key='env'").get()).toEqual({
			value: "test",
		});
		source.close();
		const before = readFileSync(sourceFile);
		copyFileSync(sourceFile, backupFile);
		const db = new DatabaseSync(backupFile);
		try {
			expect(db.prepare("SELECT value FROM _test_marker WHERE key='env'").get()).toEqual({
				value: "test",
			});
			const snapshots = db.prepare("SELECT * FROM snapshots").all();
			db.exec(cleanup);
			db.exec(migration);
			expect(
				db
					.prepare(
						"SELECT repo,starred,source,updated_at,reason FROM repo_stars ORDER BY account_id,repo",
					)
					.all(),
			).toEqual([
				{
					repo: "external/repo",
					starred: 1,
					source: "owner",
					updated_at: "2026-10-21T12:34:56.000Z",
					reason: null,
				},
				{
					repo: "Owner/App",
					starred: 1,
					source: "owner",
					updated_at: "2026-10-21T12:34:56.000Z",
					reason: null,
				},
				{
					repo: "other/app",
					starred: 1,
					source: "owner",
					updated_at: "1970-01-01T00:00:00.000Z",
					reason: null,
				},
			]);
			expect(
				db.prepare("SELECT * FROM repo_stars WHERE repo='owner/excluded'").get(),
			).toBeUndefined();
			expect(db.prepare("SELECT * FROM snapshots").all()).toEqual(snapshots);
			db.exec("INSERT INTO repo_stars(account_id,repo) VALUES('a','owner/old-column-insert')");
			expect(
				db
					.prepare(
						"SELECT starred,source,reason FROM repo_stars WHERE repo='owner/old-column-insert'",
					)
					.get(),
			).toEqual({ starred: 1, source: "owner", reason: null });
			expect(() =>
				db.exec("INSERT INTO repo_stars(account_id,repo) VALUES('a','OWNER/APP')"),
			).toThrow();
			for (const assignment of ["starred=2", "source='caller'", `reason='${"x".repeat(201)}'`])
				expect(() =>
					db.exec(`UPDATE repo_stars SET ${assignment} WHERE repo='owner/app'`),
				).toThrow();
			db.exec("UPDATE repo_stars SET starred=0,reason='manual removal' WHERE repo='owner/app'");
			expect(
				db.prepare("SELECT starred,source,reason FROM repo_stars WHERE repo='OWNER/APP'").get(),
			).toEqual({ starred: 0, source: "owner", reason: "manual removal" });
			expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
		} finally {
			db.close();
		}
		expect(readFileSync(sourceFile)).toEqual(before);
	} finally {
		if (source.isOpen) source.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("verifies legacy and migrated exports repeatedly and rejects a partial provenance migration", () => {
	const directory = mkdtempSync(join(tmpdir(), "giraffe-star-verifier-"));
	try {
		const file = join(directory, "backup.sql");
		for (const initial of [oldSchema, schema]) {
			writeFileSync(file, initial + seed);
			const result = JSON.parse(
				execFileSync("bun", ["scripts/verify-factory-migration.ts", file], { encoding: "utf8" }),
			);
			expect(result).toMatchObject({
				applied: 2,
				legacyTablesUnchanged: true,
				operationalProbe: true,
				rollbackVerified: true,
			});
		}
		writeFileSync(
			file,
			`${oldSchema}${seed}ALTER TABLE repo_stars ADD COLUMN starred INTEGER DEFAULT 1;`,
		);
		expect(() =>
			execFileSync("bun", ["scripts/verify-factory-migration.ts", file], {
				encoding: "utf8",
				stdio: "pipe",
			}),
		).toThrow(/Partial star provenance migration/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
