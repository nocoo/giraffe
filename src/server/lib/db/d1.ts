import { ApiError } from "../errors";

const CAP = 80;

export type Db = {
	readonly statements: number;
	prepare: D1Database["prepare"];
	batch: D1Database["batch"];
};

export function createDb(raw: D1Database): Db {
	let statements = 0;
	let inBatch = false;
	function bump(n = 1): void {
		if (inBatch) {
			return;
		}
		if (statements + n > CAP) {
			throw new ApiError(500, "db_error", "d1 statement cap");
		}
		statements += n;
	}
	const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
		return {
			bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
			first: async <T = Record<string, unknown>>(col?: string) => {
				bump();
				const row = await stmt.first<Record<string, unknown>>();
				if (col === undefined) {
					return row as T | null;
				}
				return (row ? row[col] : null) as T | null;
			},
			all: async <T = Record<string, unknown>>() => {
				bump();
				return stmt.all<T>();
			},
			run: async () => {
				bump();
				return stmt.run();
			},
		} as D1PreparedStatement;
	};
	return {
		get statements() {
			return statements;
		},
		prepare(query) {
			return wrap(raw.prepare(query));
		},
		async batch(statementsToRun) {
			bump(statementsToRun.length);
			inBatch = true;
			try {
				return await raw.batch(statementsToRun);
			} finally {
				inBatch = false;
			}
		},
	};
}
