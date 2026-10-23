import { ApiError } from "../errors";

const CAP = 80;
const originals = new WeakMap<object, D1PreparedStatement>();

export type D1TimingObserver = (duration: number, queries: readonly (number | null)[]) => void;

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

export function createDb(raw: D1Database, observe?: D1TimingObserver, cap = CAP): Db {
	let statements = 0;
	async function execute<Result>(operation: () => Promise<Result>, count = 1): Promise<Result> {
		if (!observe) return d1Try(operation);
		const startedAt = performance.now();
		let durations: (number | null)[] = Array.from({ length: count }, () => null);
		try {
			const result = await d1Try(operation);
			const results: unknown[] = Array.isArray(result) ? result : [result];
			durations = results.map((item) => {
				const meta = item && typeof item === "object" && "meta" in item ? item.meta : null;
				const duration =
					meta && typeof meta === "object" && "duration" in meta ? meta.duration : null;
				return typeof duration === "number" && Number.isFinite(duration) && duration >= 0
					? duration
					: null;
			});
			return result;
		} finally {
			observe(performance.now() - startedAt, durations);
		}
	}
	function bump(n = 1): void {
		if (statements + n > cap) {
			throw new ApiError(500, "db_error", "d1 statement cap");
		}
		statements += n;
	}
	const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
		const wrapped = {
			bind: (...values: unknown[]) => {
				try {
					return wrap(stmt.bind(...values));
				} catch {
					throw new ApiError(500, "db_error", "d1 error");
				}
			},
			first: async <T = Record<string, unknown>>(col?: string) => {
				bump();
				return execute(async () => {
					const row = await stmt.first<Record<string, unknown>>();
					if (col === undefined) {
						return row as T | null;
					}
					return (row ? row[col] : null) as T | null;
				});
			},
			all: async <T = Record<string, unknown>>() => {
				bump();
				return execute(() => stmt.all<T>());
			},
			run: async () => {
				bump();
				return execute(() => stmt.run());
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
			try {
				return wrap(raw.prepare(query));
			} catch {
				throw new ApiError(500, "db_error", "d1 error");
			}
		},
		async batch(statementsToRun) {
			bump(statementsToRun.length);
			return execute(
				() => raw.batch(statementsToRun.map((stmt) => originals.get(stmt) ?? stmt)),
				statementsToRun.length,
			);
		},
	};
}

export function guardedDb(db: Db, check: () => void): Db {
	function wrap(statement: D1PreparedStatement): D1PreparedStatement {
		const guarded = {
			bind: (...values: unknown[]) => wrap(statement.bind(...values)),
			first: <Result>(column?: string) => {
				check();
				return column === undefined ? statement.first<Result>() : statement.first<Result>(column);
			},
			all: <Result>() => {
				check();
				return statement.all<Result>();
			},
			run: () => {
				check();
				return statement.run();
			},
		} as D1PreparedStatement;
		originals.set(guarded, originals.get(statement) ?? statement);
		return guarded;
	}
	return {
		get statements() {
			return db.statements;
		},
		prepare: (query) => wrap(db.prepare(query)),
		batch: (statements) => {
			check();
			return db.batch(statements);
		},
	};
}
