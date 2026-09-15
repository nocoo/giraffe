import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
/** Real SQLite adapter for D1 transaction/concurrency unit tests. No remote resources. */
export function sqliteFixture(): D1Database {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync("src/server/lib/db/schema.sql", "utf8"));
	function statement(sql: string, values: SQLInputValue[] = []): D1PreparedStatement {
		const run = () => db.prepare(sql);
		return {
			bind: (...v: unknown[]) => statement(sql, v as SQLInputValue[]),
			first: async () => run().get(...values) ?? null,
			all: async () => ({ success: true, results: run().all(...values), meta: {} }),
			run: async () => ({
				success: true,
				results: [],
				meta: { changes: Number(run().run(...values).changes) },
			}),
		} as unknown as D1PreparedStatement;
	}
	return {
		prepare: (sql: string) => statement(sql),
		batch: async (stmts: D1PreparedStatement[]) => {
			db.exec("BEGIN");
			try {
				const result = [];
				for (const stmt of stmts) result.push(await stmt.run());
				db.exec("COMMIT");
				return result;
			} catch (e) {
				db.exec("ROLLBACK");
				throw e;
			}
		},
	} as unknown as D1Database;
}
