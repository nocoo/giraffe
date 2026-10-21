export function profileDb(raw: D1Database) {
	const queries: { sql: string; ms: number; rows: number; payloadBytes: number }[] = [];
	const wrap = (sql: string, statement: D1PreparedStatement): D1PreparedStatement => {
		async function measure<T>(operation: () => Promise<T>) {
			const start = performance.now();
			const result = await operation();
			const ms = performance.now() - start;
			return { result, ms };
		}
		const record = (ms: number, rows: unknown[]) => {
			queries.push({
				sql,
				ms,
				rows: rows.length,
				payloadBytes: rows.reduce<number>((bytes, row) => {
					if (row && typeof row === "object" && "payload" in row && typeof row.payload === "string")
						return bytes + new TextEncoder().encode(row.payload).byteLength;
					return bytes;
				}, 0),
			});
		};
		return {
			bind: (...values: unknown[]) => wrap(sql, statement.bind(...values)),
			all: async <T>() => {
				const { result, ms } = await measure(() => statement.all<T>());
				record(ms, result.results);
				return result;
			},
			first: async <T>() => {
				const { result, ms } = await measure(() => statement.first<T>());
				record(ms, result === null ? [] : [result]);
				return result;
			},
			run: () => {
				throw new Error("source profiling forbids database writes");
			},
		} as unknown as D1PreparedStatement;
	};
	return {
		queries,
		raw: {
			prepare: (sql: string) => wrap(sql, raw.prepare(sql)),
			batch: () => {
				throw new Error("source profiling forbids database batches");
			},
		} as unknown as D1Database,
	};
}
