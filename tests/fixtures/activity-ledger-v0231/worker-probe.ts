import { Database, type SQLQueryBindings } from "bun:sqlite";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [sourceRoot, databaseFile] = process.argv.slice(2);
if (!sourceRoot || !databaseFile)
	throw new Error("Expected archived source and local test database");
const sqlite = new Database(databaseFile, { strict: true });
sqlite.exec("PRAGMA foreign_keys=ON");
if (sqlite.query("SELECT value FROM _test_marker WHERE key='env'").get()?.value !== "test")
	throw new Error("Not a test database");

const runners = new WeakMap<D1PreparedStatement, () => D1Result>();
function statement(sql: string, values: SQLQueryBindings[] = []): D1PreparedStatement {
	const query = () => sqlite.query(sql);
	const execute = () => {
		const prepared = query();
		const reads = prepared.columnNames.length > 0;
		return {
			success: true,
			results: reads ? prepared.all(...values) : [],
			meta: { changes: reads ? 0 : prepared.run(...values).changes },
		} as D1Result;
	};
	const prepared = {
		bind: (...bindings: SQLQueryBindings[]) => statement(sql, bindings),
		first: async () => query().get(...values) ?? null,
		all: async () => execute(),
		run: async () => execute(),
	} as D1PreparedStatement;
	runners.set(prepared, execute);
	return prepared;
}

globalThis.fetch = () => {
	throw new Error("Network denied in archived Worker compatibility probe");
};

try {
	const { default: worker } = await import(
		pathToFileURL(resolve(sourceRoot, "apps/web/src/server/index.ts")).href
	);
	const db = {
		prepare: statement,
		batch: async (statements: D1PreparedStatement[]) =>
			sqlite.transaction(() =>
				statements.map((prepared) => {
					const execute = runners.get(prepared);
					if (!execute) throw new Error("Foreign test statement");
					return execute();
				}),
			)(),
	} as D1Database;
	const env = {
		DB: db,
		ASSETS: { fetch: globalThis.fetch },
		FACTORY_QUEUE: {},
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://127.0.0.1:1",
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
		TOKEN_ENCRYPTION_KEY_V1: "0".repeat(64),
	};
	const responses = [];
	for (const [path, method] of [
		["/api/live", "GET"],
		["/api/accounts", "GET"],
		["/api/repos?scope=all", "GET"],
		["/api/notifications?scope=all", "GET"],
		["/api/accounts/other/activate", "POST"],
		["/api/accounts/other", "DELETE"],
	]) {
		const response = await worker.fetch(
			new Request(`http://fixture.invalid${path}`, {
				method,
				headers: { origin: "http://fixture.invalid" },
			}),
			env,
			{
				waitUntil: () => {
					throw new Error("Unexpected background work");
				},
			},
		);
		responses.push({ path, status: response.status, body: await response.text() });
	}
	console.log(JSON.stringify(responses));
} finally {
	sqlite.close();
}
