import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

const timestamp = "2026-10-18T12:03:11.294Z";
const targets = [
	"base-ci",
	"base-cli",
	"base-mcp",
	"diorama-journey",
	"eagle",
	"falcon",
	"gaga",
	"hexly.ai",
	"his.fm",
	"kite",
	"lizheng.dev",
	"next-ai",
	"octo",
	"rhino",
	"rio",
	"sleepy",
	"zeppelin",
	"zoo",
];
const legacySchema = `
PRAGMA foreign_keys=ON;
CREATE TABLE _test_marker(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO _test_marker VALUES('env','test');
CREATE TABLE accounts (
 id TEXT PRIMARY KEY, login TEXT NOT NULL, avatar_url TEXT NOT NULL DEFAULT '',
 token_ciphertext TEXT NOT NULL, token_last4 TEXT NOT NULL,
 key_version INTEGER NOT NULL DEFAULT 1, scopes TEXT NOT NULL DEFAULT '',
 capabilities TEXT NOT NULL DEFAULT '{}',
 is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT
);
CREATE UNIQUE INDEX accounts_login ON accounts(login);
CREATE UNIQUE INDEX accounts_one_active ON accounts(is_active) WHERE is_active=1;
CREATE TABLE repo_stars (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 repo TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY(account_id,repo)
);
`;

function fixture(db: DatabaseSync, login = "NoCoO") {
	db.exec(legacySchema);
	const account = db.prepare(
		"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?,'fake','fake',?,?)",
	);
	account.run("a", login, timestamp, timestamp);
	account.run("b", "other", timestamp, timestamp);
	const star = db.prepare("INSERT INTO repo_stars(account_id,repo) VALUES(?,?)");
	for (const [index, name] of targets.entries()) {
		star.run("a", index % 2 === 0 ? `NoCoO/${name.toUpperCase()}` : `nocoo/${name}`);
		star.run("b", `nocoo/${name}`);
	}
	for (let index = 0; index < 42; index++) star.run("a", `nocoo/baseline-${index}`);
	star.run("a", "nocoo/nineteenth");
	star.run("a", "external/base-ci");
	db.exec(readFileSync("migrations/0017_star_provenance.sql", "utf8"));
}

function correct(db: DatabaseSync) {
	db.exec(readFileSync("migrations/0021_star_provenance_correction.sql", "utf8"));
	return db.prepare("SELECT changes() AS count").get();
}

function rows(db: DatabaseSync) {
	return db.prepare("SELECT * FROM repo_stars ORDER BY account_id,repo").all();
}

it("corrects exactly 18 of 60 baseline stars plus decoys on a marked backup, preserving every other value", () => {
	const directory = mkdtempSync(join(tmpdir(), "giraffe-star-correction-"));
	const sourceFile = join(directory, "source.sqlite");
	const backupFile = join(directory, "backup.sqlite");
	const source = new DatabaseSync(sourceFile);
	try {
		fixture(source);
		expect(source.prepare("SELECT value FROM _test_marker WHERE key='env'").get()).toEqual({
			value: "test",
		});
		source.close();
		const original = readFileSync(sourceFile);
		copyFileSync(sourceFile, backupFile);
		const db = new DatabaseSync(backupFile);
		try {
			expect(db.prepare("SELECT value FROM _test_marker WHERE key='env'").get()).toEqual({
				value: "test",
			});
			const before = rows(db);
			const accounts = db.prepare("SELECT * FROM accounts ORDER BY id").all();
			expect(before).toHaveLength(80);
			expect(before.filter((row) => row.account_id === "a")).toHaveLength(62);
			expect(before.every((row) => row.updated_at === timestamp)).toBe(true);
			expect(correct(db)).toEqual({ count: 18 });
			const expected = before.map((row) =>
				row.account_id === "a" &&
				targets.some((name) => `nocoo/${name}` === String(row.repo).toLowerCase())
					? { ...row, source: "agent" }
					: row,
			);
			expect(rows(db)).toEqual(expected);
			expect(correct(db)).toEqual({ count: 0 });
			expect(rows(db)).toEqual(expected);
			expect(db.prepare("SELECT * FROM accounts ORDER BY id").all()).toEqual(accounts);
			expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
		} finally {
			db.close();
		}
		expect(readFileSync(sourceFile)).toEqual(original);
	} finally {
		if (source.isOpen) source.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it.each([
	"updated_at='2026-10-22T00:44:00.000Z'",
	"updated_at='2026-10-18T12:03:11.294+00:00'",
	"starred=0",
	"source='agent'",
	"reason='owner decision'",
	"reason=''",
])("preserves a target with %s and corrects only the other 17", (assignment) => {
	const db = new DatabaseSync(":memory:");
	try {
		fixture(db, "nocoo");
		db.exec(`UPDATE repo_stars SET ${assignment} WHERE account_id='a' AND repo='nocoo/base-ci'`);
		const saved = db
			.prepare("SELECT * FROM repo_stars WHERE account_id='a' AND repo='nocoo/base-ci'")
			.get();
		expect(correct(db)).toEqual({ count: 17 });
		expect(
			db.prepare("SELECT * FROM repo_stars WHERE account_id='a' AND repo='nocoo/base-ci'").get(),
		).toEqual(saved);
		expect(correct(db)).toEqual({ count: 0 });
	} finally {
		db.close();
	}
});

it("is a no-op for an unrelated account even with all 18 matching repository keys", () => {
	const db = new DatabaseSync(":memory:");
	try {
		fixture(db, "unrelated");
		const before = rows(db);
		expect(correct(db)).toEqual({ count: 0 });
		expect(rows(db)).toEqual(before);
	} finally {
		db.close();
	}
});
