import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import provenance from "../../../../../tests/fixtures/activity-ledger-v0231/provenance.json";

const fixture = "tests/fixtures/activity-ledger-v0231";
const archive = resolve(fixture, "worker-source.tar.gz");
const oldSchema = execFileSync("tar", ["-xOzf", archive, "apps/web/src/server/lib/db/schema.sql"], {
	encoding: "utf8",
});
const migration = () => readFileSync("migrations/0026_activity_commit_ledger.sql", "utf8");
const seed = readFileSync(join(fixture, "seed.sql"), "utf8");

function legacyRows(db: DatabaseSync) {
	const tables = db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all() as { name: string }[];
	return Object.fromEntries(
		tables
			.filter(({ name }) => !name.startsWith("activity_commit_"))
			.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]),
	);
}

it("pins the actual v0.23.1 source and appends the identical additive migration to the fresh schema", () => {
	expect(createHash("sha256").update(readFileSync(archive)).digest("hex")).toBe(
		provenance.archiveSha256,
	);
	expect(createHash("sha256").update(oldSchema).digest("hex")).toBe(provenance.schemaSha256);
	const appended = [
		migration(),
		readFileSync("migrations/0027_retract_hollow_activity_publications.sql", "utf8"),
		readFileSync("migrations/0028_refresh_observations.sql", "utf8"),
		readFileSync("migrations/0029_refresh_runs.sql", "utf8"),
		readFileSync("migrations/0030_refresh_run_cancel.sql", "utf8"),
	].join("\n");
	expect(readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8")).toBe(
		`${oldSchema}\n${appended}`,
	);
	expect(migration()).not.toMatch(/^\s*(?:CREATE\s+TRIGGER|INSERT|UPDATE|DELETE|DROP|ALTER)\b/im);
});

it.each(["fresh", "v0.23.1"])(
	"adds the exact heads/ledger/index contract on %s SQLite without backfill and is repeatable",
	(shape) => {
		const db = new DatabaseSync(":memory:");
		try {
			db.exec("PRAGMA foreign_keys=ON");
			db.exec(
				shape === "fresh"
					? readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8")
					: oldSchema,
			);
			db.exec(seed);
			const rows = legacyRows(db);
			const objects = db
				.prepare(
					"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name NOT LIKE 'activity_commit_%' ORDER BY name",
				)
				.all();
			db.exec(migration());
			db.exec(migration());
			expect(legacyRows(db)).toEqual(rows);
			expect(
				db
					.prepare(
						"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name NOT LIKE 'activity_commit_%' ORDER BY name",
					)
					.all(),
			).toEqual(objects);
			for (const [table, columns] of [
				[
					"activity_commit_heads",
					[
						["account_id", 1, 1],
						["repo_id", 1, 2],
						["head", 0, 0],
						["pending", 0, 0],
					],
				],
				[
					"activity_commit_ledger",
					[
						["account_id", 1, 1],
						["repo_id", 1, 2],
						["sha", 1, 3],
						["first_run_id", 1, 0],
						["observed_at", 1, 0],
						["window_since", 1, 0],
						["window_until", 1, 0],
						["payload", 0, 0],
						["published_run_id", 0, 0],
						["reconciliation", 1, 0],
					],
				],
			] as const) {
				expect(db.prepare(`PRAGMA table_info(${table})`).all()).toEqual(
					columns.map(([name, notnull, pk], cid) => ({
						cid,
						name,
						type: "TEXT",
						notnull,
						dflt_value: name === "reconciliation" ? "''" : null,
						pk,
					})),
				);
				expect(db.prepare(`PRAGMA foreign_key_list(${table})`).all()).toEqual([
					{
						id: 0,
						seq: 0,
						table: "accounts",
						from: "account_id",
						to: "id",
						on_update: "NO ACTION",
						on_delete: "CASCADE",
						match: "NONE",
					},
				]);
				expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
			}
			expect(
				db
					.prepare("SELECT name FROM pragma_index_info('activity_commit_pending') ORDER BY seqno")
					.all(),
			).toEqual([{ name: "account_id" }, { name: "repo_id" }, { name: "published_run_id" }]);
			expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
		} finally {
			db.close();
		}
	},
);

it("the actual archived v0.23.1 Worker serves local API reads and writes after upgrade, leaving the ledger unused", () => {
	const directory = mkdtempSync(join(tmpdir(), "giraffe-ledger-old-worker-"));
	writeFileSync(join(directory, ".test-owner"), "b16a-fake-only");
	const file = join(directory, "fixture.sqlite");
	const db = new DatabaseSync(file);
	try {
		db.exec("PRAGMA foreign_keys=ON");
		db.exec(oldSchema + seed);
		const before = legacyRows(db);
		db.exec(migration());
		expect(legacyRows(db)).toEqual(before);
		for (const account of ["legacy", "other"]) {
			db.prepare("INSERT INTO activity_commit_heads VALUES(?,?,?,?)").run(
				account,
				"R_fixture",
				"fixture-sha",
				'{"cursor":"fake"}',
			);
			db.prepare("INSERT INTO activity_commit_ledger VALUES(?,?,?,?,?,?,?,?,?,'fixture')").run(
				account,
				"R_fixture",
				"fixture-sha",
				"absent-run",
				"observed",
				"since",
				"until",
				'{"fake":true}',
				null,
			);
		}
		const heads = db.prepare("SELECT * FROM activity_commit_heads WHERE account_id='legacy'").all();
		const ledger = db
			.prepare("SELECT * FROM activity_commit_ledger WHERE account_id='legacy'")
			.all();
		execFileSync("tar", ["-xzf", archive, "-C", directory]);
		symlinkSync(resolve("node_modules"), join(directory, "node_modules"), "dir");
		const responses = JSON.parse(
			execFileSync("bun", [resolve(fixture, "worker-probe.ts"), directory, file], {
				encoding: "utf8",
				timeout: 20_000,
			}),
		) as { path: string; status: number; body: string }[];
		expect(responses.map(({ status }) => status)).toEqual([200, 200, 200, 200, 200, 204]);
		expect(JSON.parse(responses[0]?.body ?? "{}")).toMatchObject({
			status: "ok",
			version: "0.23.1",
			database: { connected: true },
			d1_marker: "test",
		});
		expect(JSON.parse(responses[1]?.body ?? "{}")).toMatchObject({
			accounts: [{ id: "other" }, { id: "legacy" }],
		});
		expect(JSON.parse(responses[2]?.body ?? "{}")).toMatchObject({
			account_id: "legacy",
			repos: [],
		});
		expect(JSON.parse(responses[3]?.body ?? "{}")).toMatchObject({
			account_id: "legacy",
			notifications: [],
		});
		expect(
			db.prepare("SELECT * FROM activity_commit_heads WHERE account_id='legacy'").all(),
		).toEqual(heads);
		expect(
			db.prepare("SELECT * FROM activity_commit_ledger WHERE account_id='legacy'").all(),
		).toEqual(ledger);
		expect(
			db.prepare("SELECT * FROM activity_commit_heads WHERE account_id='other'").all(),
		).toEqual([]);
		expect(
			db.prepare("SELECT * FROM activity_commit_ledger WHERE account_id='other'").all(),
		).toEqual([]);
		db.exec(migration());
		expect(
			db.prepare("SELECT * FROM activity_commit_ledger WHERE account_id='legacy'").all(),
		).toEqual(ledger);
		expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
	} finally {
		db.close();
		expect(readFileSync(join(directory, ".test-owner"), "utf8")).toBe("b16a-fake-only");
		rmSync(directory, { recursive: true, force: true });
	}
});
