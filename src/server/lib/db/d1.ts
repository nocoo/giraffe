import { ApiError } from "../errors";

const CAP = 80;

export type Db = {
	readonly statements: number;
	prepare: D1Database["prepare"];
	batch: D1Database["batch"];
};

async function d1Try<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch {
		throw new ApiError(500, "db_error", "d1 error");
	}
}

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
	const originals = new WeakMap<object, D1PreparedStatement>();
	const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
		const wrapped = {
			bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
			first: async <T = Record<string, unknown>>(col?: string) => {
				bump();
				return d1Try(async () => {
					const row = await stmt.first<Record<string, unknown>>();
					if (col === undefined) {
						return row as T | null;
					}
					return (row ? row[col] : null) as T | null;
				});
			},
			all: async <T = Record<string, unknown>>() => {
				bump();
				return d1Try(() => stmt.all<T>());
			},
			run: async () => {
				bump();
				return d1Try(() => stmt.run());
			},
		} as D1PreparedStatement;
		originals.set(wrapped, stmt);
		return wrapped;
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
				return await d1Try(() =>
					raw.batch(statementsToRun.map((stmt) => originals.get(stmt) ?? stmt)),
				);
			} finally {
				inBatch = false;
			}
		},
	};
}
