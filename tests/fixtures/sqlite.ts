import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
/** Real SQLite adapter for D1 transaction/concurrency unit tests. No remote resources. */
export function sqliteFixture(): D1Database {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys=ON");
	const runners = new WeakMap<D1PreparedStatement, () => D1Result>();
	db.exec(readFileSync("src/server/lib/db/schema.sql", "utf8"));
	function statement(sql: string, values: SQLInputValue[] = []): D1PreparedStatement {
		const run = () => db.prepare(sql);
		const execute = () =>
			({
				success: true,
				results: [],
				meta: { changes: Number(run().run(...values).changes) },
			}) as unknown as D1Result;
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
