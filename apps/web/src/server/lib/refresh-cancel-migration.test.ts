import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

const modern = (id: string, status: string) =>
	JSON.stringify({
		id,
		accountId: "account",
		status,
		phase: "repos",
		repos: ["owner/project"],
		completedRepos: 0,
		requests: 0,
		requestBreakdown: {
			total: 0,
			graphql: 0,
			rest: 0,
			a: { graphql: 0, rest: 0 },
			b: { graphql: 0, rest: 0 },
		},
		partialReasons: [],
		partial: false,
		cancelRequested: false,
		errorCode: null,
		createdAt: "2026-10-29T01:00:00.000Z",
		updatedAt: "2026-10-29T01:00:00.000Z",
		finishedAt: null,
	});

it("widens the status constraint and retires pre-0.27.1 active payloads without inventing counts", () => {
	const migration = readFileSync("migrations/0030_refresh_run_cancel.sql", "utf8");
	const schema = readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8");
	expect(schema.includes(migration)).toBe(true);
	const directory = mkdtempSync(join(tmpdir(), "giraffe-cancel-migration-"));
	const original = join(directory, "original.sqlite");
	const backup = join(directory, "backup.sqlite");
	const source = new DatabaseSync(original);
	try {
		source.exec("PRAGMA foreign_keys=ON");
		source.exec(schema.slice(0, schema.indexOf(migration)));
		source.exec(
			"CREATE TABLE _test_marker(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO _test_marker VALUES('env','test'),('run','cancel'); CREATE TABLE _test_kept(key TEXT PRIMARY KEY,value TEXT); INSERT INTO _test_kept VALUES('kept','yes')",
		);
		source.exec(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('account','owner','fake','fake','old','old')",
		);
		const legacy = (id: string, status: string) =>
			JSON.stringify({
				id,
				accountId: "account",
				status,
				phase: "repos",
				repos: ["owner/project"],
				completedRepos: 1,
				requests: 5,
				partial: false,
				errorCode: null,
				createdAt: "2026-10-28T19:00:00.000Z",
				updatedAt: "2026-10-28T20:00:00.000Z",
				finishedAt: status === "running" || status === "queued" ? null : "2026-10-28T20:00:00.000Z",
			});
		const insert = source.prepare(
			"INSERT INTO refresh_runs(id,account_id,status,trigger,schedule_day,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
		);
		insert.run(
			"legacy-running",
			"account",
			"running",
			"manual",
			null,
			legacy("legacy-running", "running"),
			"2026-10-28T19:00:00.000Z",
			"2026-10-28T20:00:00.000Z",
		);
		insert.run(
			"legacy-queued",
			"account",
			"queued",
			"manual",
			null,
			legacy("legacy-queued", "queued"),
			"2026-10-28T19:00:00.000Z",
			"2026-10-28T20:00:00.000Z",
		);
		insert.run(
			"legacy-done",
			"account",
			"completed",
			"manual",
			null,
			legacy("legacy-done", "completed"),
			"2026-10-28T19:00:00.000Z",
			"2026-10-28T20:00:00.000Z",
		);
		insert.run(
			"modern",
			"account",
			"queued",
			"manual",
			null,
			modern("modern", "queued"),
			"2026-10-29T01:00:00.000Z",
			"2026-10-29T01:00:00.000Z",
		);
	} finally {
		source.close();
	}
	copyFileSync(original, backup);
	const database = new DatabaseSync(backup);
	try {
		database.exec("PRAGMA foreign_keys=ON");
		const rows = () =>
			Object.fromEntries(
				database
					.prepare("SELECT id,status,payload,updated_at FROM refresh_runs ORDER BY id")
					.all()
					.map((row) => [String((row as { id: string }).id), row]),
			);
		const before = rows();
		for (let pass = 0; pass < 2; pass++) database.exec(migration);
		const after = rows();
		for (const id of ["legacy-done", "modern"]) expect(after[id]).toEqual(before[id]);
		for (const id of ["legacy-running", "legacy-queued"]) {
			expect(after[id]).toMatchObject({ status: "failed", updated_at: "2026-10-28T20:00:00.000Z" });
			const payload = JSON.parse(String((after[id] as { payload: string }).payload));
			expect(payload).toMatchObject({
				id,
				status: "failed",
				phase: "done",
				errorCode: "refresh_schema_cutover",
				requests: 5,
				repos: ["owner/project"],
				completedRepos: 1,
				createdAt: "2026-10-28T19:00:00.000Z",
				updatedAt: "2026-10-28T20:00:00.000Z",
				finishedAt: "2026-10-28T20:00:00.000Z",
			});
			expect(payload.requestBreakdown).toBeUndefined();
			expect(payload.partialReasons).toBeUndefined();
			expect(payload.cancelRequested).toBeUndefined();
		}
		expect(database.prepare("SELECT * FROM _test_kept").all()).toEqual([
			{ key: "kept", value: "yes" },
		]);
		expect(database.prepare("SELECT * FROM _test_marker ORDER BY key").all()).toEqual([
			{ key: "env", value: "test" },
			{ key: "run", value: "cancel" },
		]);
		expect(
			database
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='refresh_runs' ORDER BY name",
				)
				.all(),
		).toEqual([
			{ name: "refresh_run_active" },
			{ name: "refresh_run_history" },
			{ name: "refresh_run_schedule" },
			{ name: "sqlite_autoindex_refresh_runs_1" },
		]);
		expect(() =>
			database.prepare("UPDATE refresh_runs SET status='cancelled' WHERE id='modern'").run(),
		).not.toThrow();
		expect(() =>
			database.prepare("UPDATE refresh_runs SET status='retired' WHERE id='modern'").run(),
		).toThrow();
		expect(() =>
			database
				.prepare(
					"INSERT INTO refresh_runs(id,account_id,status,trigger,payload,created_at,updated_at) VALUES('second-running','account','running','manual','{}','now','now')",
				)
				.run(),
		).not.toThrow();
		expect(() =>
			database
				.prepare(
					"INSERT INTO refresh_runs(id,account_id,status,trigger,payload,created_at,updated_at) VALUES('third-running','account','running','manual','{}','now','now')",
				)
				.run(),
		).toThrow();
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
