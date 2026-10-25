import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect, it } from "vitest";
import { readActivity } from "./activity-store";
import { createDb, type Db } from "./db/d1";

const migration = () =>
	readFileSync("migrations/0027_retract_hollow_activity_publications.sql", "utf8");
const now = "2026-10-25T12:00:00.000Z";
const earlier = "2026-10-24T12:00:00.000Z";

function schemaBeforeHeal() {
	const schema = readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8");
	const heal = migration();
	return schema.endsWith(heal) ? schema.slice(0, -heal.length) : schema;
}

function d1Database(db: DatabaseSync): D1Database {
	const runners = new WeakMap<D1PreparedStatement, () => D1Result>();
	function statement(sql: string, values: SQLInputValue[] = []): D1PreparedStatement {
		const run = () => db.prepare(sql);
		const execute = () => {
			const query = run();
			return {
				success: true,
				results: query.columns().length ? query.all(...values) : [],
				meta: { changes: query.columns().length ? 0 : Number(query.run(...values).changes) },
			} as unknown as D1Result;
		};
		const prepared = {
			bind: (...v: unknown[]) => statement(sql, v as SQLInputValue[]),
			first: async () => run().get(...values) ?? null,
			all: async () => ({ success: true, results: run().all(...values), meta: {} }),
			run: async () => execute(),
		} as unknown as D1PreparedStatement;
		runners.set(prepared, execute);
		return prepared;
	}
	return {
		prepare: (sql: string) => statement(sql),
		batch: async (stmts: D1PreparedStatement[]) => {
			db.exec("BEGIN");
			try {
				const result = [];
				for (const stmt of stmts) {
					const run = runners.get(stmt);
					if (!run) throw new Error("foreign statement");
					result.push(run());
				}
				db.exec("COMMIT");
				return result;
			} catch (e) {
				db.exec("ROLLBACK");
				throw e;
			}
		},
	} as unknown as D1Database;
}

function apply(db: DatabaseSync) {
	db.exec(migration());
}

async function seedActivityDb(db: Db) {
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('account_123','nocoo','fake','fake',?,?)",
		)
		.bind(now, now)
		.run();
	await db
		.prepare(
			`INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES
 ('good','account_123','good','completed','{}',?,?,?),
 ('hollow','account_123','hollow','partial','{}',?,?,?)`,
		)
		.bind(now, now, now, now, now, now)
		.run();
	const goodHeader = JSON.stringify({
		account_id: "account_123",
		window: { since: earlier, until: earlier, first: false, gap: false },
		runId: "good",
		previousRunId: null,
		fetchedAt: earlier,
		repos: [],
		totals: {},
		coverage: {},
		truncated: false,
	});
	const hollowHeader = JSON.stringify({
		account_id: "account_123",
		window: { since: earlier, until: now, first: false, gap: false },
		runId: "hollow",
		previousRunId: "good",
		fetchedAt: now,
		repos: [],
		totals: {},
		coverage: {},
		truncated: false,
	});
	await db
		.prepare(
			`INSERT INTO activity_publications(account_id,run_id,previous_run_id,until_at,fetched_at,payload,content_version) VALUES
 ('account_123','good',NULL,?,?,?,'good'),
 ('account_123','hollow','good',?,?,?,'hollow')`,
		)
		.bind(earlier, earlier, goodHeader, now, now, hollowHeader)
		.run();
	await db
		.prepare(
			`INSERT INTO activity_pages(account_id,run_id,page,payload) VALUES
 ('account_123','good',0,'[]'),
 ('account_123','hollow',0,'[]')`,
		)
		.run();
	await db
		.prepare(
			"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES('good','nocoo/app','activity-snapshot','{\"repo\":\"nocoo/app\"}')",
		)
		.run();
	await db
		.prepare(
			`INSERT INTO activity_commit_ledger(account_id,repo_id,sha,first_run_id,observed_at,window_since,window_until,payload,published_run_id,reconciliation) VALUES
 ('account_123','repo-1','sha-hollow','hollow',?,?,?,NULL,'hollow',''),
 ('account_123','repo-1','sha-pending','hollow',?,?,?,'{"sha":"sha-pending"}',NULL,'')`,
		)
		.bind(now, earlier, now, now, earlier, now)
		.run();
}

it("retracts hollow activity publications without frozen snapshots and restores the prior good latest head", async () => {
	const sync = new DatabaseSync(":memory:");
	try {
		sync.exec("PRAGMA foreign_keys=ON");
		sync.exec(schemaBeforeHeal());
		const db = createDb(d1Database(sync));
		await seedActivityDb(db);
		expect((await readActivity(db, "account_123", {})).runId).toBe("hollow");
		apply(sync);
		expect(sync.prepare("SELECT run_id FROM activity_publications ORDER BY run_id").all()).toEqual([
			{ run_id: "good" },
		]);
		expect(sync.prepare("SELECT run_id FROM activity_pages ORDER BY run_id").all()).toEqual([
			{ run_id: "good" },
		]);
		expect((await readActivity(db, "account_123", {})).runId).toBe("good");
		const ledger = sync
			.prepare("SELECT sha,published_run_id FROM activity_commit_ledger ORDER BY sha")
			.all() as { sha: string; published_run_id: string | null }[];
		expect(ledger).toEqual([
			{ sha: "sha-hollow", published_run_id: null },
			{ sha: "sha-pending", published_run_id: null },
		]);
		apply(sync);
		expect(sync.prepare("SELECT run_id FROM activity_publications").all()).toEqual([
			{ run_id: "good" },
		]);
	} finally {
		sync.close();
	}
});

it("leaves publications with activity-snapshot rows untouched on a marked backup", async () => {
	const directory = mkdtempSync(join(tmpdir(), "giraffe-hollow-activity-"));
	const sourceFile = join(directory, "source.sqlite");
	const backupFile = join(directory, "backup.sqlite");
	const source = new DatabaseSync(sourceFile);
	try {
		source.exec("PRAGMA foreign_keys=ON");
		source.exec(schemaBeforeHeal());
		await seedActivityDb(createDb(d1Database(source)));
		source.exec(
			"CREATE TABLE IF NOT EXISTS _test_marker(key TEXT PRIMARY KEY,value TEXT); INSERT INTO _test_marker VALUES('env','test');",
		);
		const before = source.prepare("SELECT * FROM activity_publications ORDER BY run_id").all();
		source.close();
		copyFileSync(sourceFile, backupFile);
		const backup = new DatabaseSync(backupFile);
		try {
			expect(backup.prepare("SELECT value FROM _test_marker WHERE key='env'").get()).toEqual({
				value: "test",
			});
			apply(backup);
			const after = backup.prepare("SELECT * FROM activity_publications ORDER BY run_id").all();
			expect(after).toEqual([before[0]]);
			apply(backup);
			expect(backup.prepare("SELECT * FROM activity_publications ORDER BY run_id").all()).toEqual(
				after,
			);
			expect(backup.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			backup.close();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
