import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

it("R9 migration 0022 preserves marked backup rows and replays without inventing historical readiness", () => {
	const directory = mkdtempSync(join(tmpdir(), "giraffe-readiness-"));
	try {
		const source = join(directory, "source.sqlite");
		const original = new DatabaseSync(source);
		original.exec(
			"CREATE TABLE _test_marker(key TEXT PRIMARY KEY,value TEXT); INSERT INTO _test_marker VALUES('env','test'); CREATE TABLE factory_runs(id TEXT PRIMARY KEY,payload TEXT);",
		);
		for (const status of ["completed", "partial", "running", "failed", "cancelled"])
			original
				.prepare("INSERT INTO factory_runs VALUES(?,?)")
				.run(status, JSON.stringify({ id: status, status, finishedAt: "2026-10-22T00:00:00Z" }));
		original.close();
		const backup = join(directory, "backup.sqlite");
		copyFileSync(source, backup);
		const db = new DatabaseSync(backup);
		try {
			expect(db.prepare("SELECT value FROM _test_marker WHERE key='env'").get()).toMatchObject({
				value: "test",
			});
			const migration = readFileSync("migrations/0022_run_readiness.sql", "utf8");
			const before = db.prepare("SELECT * FROM factory_runs ORDER BY id").all() as {
				id: string;
				payload: string;
			}[];
			db.exec(migration);
			const after = db.prepare("SELECT * FROM factory_runs ORDER BY id").all();
			expect(after).toEqual(
				before.map((row) => ({
					...row,
					payload: JSON.stringify({ ...JSON.parse(row.payload), publishedAt: null }),
				})),
			);
			db.exec(migration);
			expect(db.prepare("SELECT * FROM factory_runs ORDER BY id").all()).toEqual(after);
		} finally {
			db.close();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
