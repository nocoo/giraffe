export function profileDb(raw: D1Database, latencyMs = 0) {
	type Statement = { sql: string; statement: D1PreparedStatement; bindings: unknown[] };
	const queries: {
		sql: string;
		bindings: unknown[];
		ms: number;
		rows: number;
		payloadBytes: number;
	}[] = [];
	const trips: { statements: number; ms: number }[] = [];
	const originals = new WeakMap<D1PreparedStatement, Statement>();
	function assertRead(sql: string) {
		if (
			!/^\s*(SELECT|WITH|EXPLAIN QUERY PLAN)\b/i.test(sql) ||
			/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql)
		)
			throw new Error("source profiling forbids database writes");
	}
	async function trip<T>(count: number, operation: () => Promise<T>) {
		const start = performance.now();
		if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs));
		const result = await operation();
		trips.push({ statements: count, ms: performance.now() - start });
		return result;
	}
	const record = (entry: Statement, ms: number, rows: unknown[]) => {
		queries.push({
			sql: entry.sql,
			bindings: entry.bindings,
			ms,
			rows: rows.length,
			payloadBytes: rows.reduce<number>((bytes, row) => {
				if (row && typeof row === "object" && "payload" in row && typeof row.payload === "string")
					return bytes + new TextEncoder().encode(row.payload).byteLength;
				return bytes;
			}, 0),
		});
	};
	const wrap = (entry: Statement): D1PreparedStatement => {
		const { sql, statement } = entry;
		const wrapped = {
			bind: (...bindings: unknown[]) =>
				wrap({ sql, statement: statement.bind(...bindings), bindings }),
			all: async <T>() => {
				assertRead(sql);
				return trip(1, async () => {
					const start = performance.now();
					const result = await statement.all<T>();
					record(entry, performance.now() - start, result.results);
					return result;
				});
			},
			first: async <T>() => {
				assertRead(sql);
				return trip(1, async () => {
					const start = performance.now();
					const result = await statement.first<T>();
					record(entry, performance.now() - start, result === null ? [] : [result]);
					return result;
				});
			},
			run: () => {
				throw new Error("source profiling forbids database writes");
			},
		} as unknown as D1PreparedStatement;
		originals.set(wrapped, entry);
		return wrapped;
	};
	return {
		queries,
		trips,
		raw: {
			prepare: (sql: string) => wrap({ sql, statement: raw.prepare(sql), bindings: [] }),
			batch: async <T>(statements: D1PreparedStatement[]) => {
				const entries = statements.map((statement) => {
					const entry = originals.get(statement);
					if (!entry) throw new Error("source profiling requires owned statements");
					assertRead(entry.sql);
					return entry;
				});
				return trip(entries.length, async () => {
					const start = performance.now();
					const results = await raw.batch<T>(entries.map((entry) => entry.statement));
					const ms = performance.now() - start;
					for (const [index, entry] of entries.entries())
						record(entry, ms / entries.length, results[index]?.results ?? []);
					return results;
				});
			},
		} as unknown as D1Database,
	};
}
