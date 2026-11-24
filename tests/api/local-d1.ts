import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

type FixtureContext = { persist: string; config: string; root?: string };

function findSqliteFile(persist: string): string {
	const dir = join(persist, "v3/d1/miniflare-D1DatabaseObject");
	const file = readdirSync(dir).find((name) => name.endsWith(".sqlite"));
	if (!file) throw new Error(`no local D1 sqlite file found in ${dir}`);
	return join(dir, file);
}

export function executeLocalD1Sync(sql: string, context: FixtureContext): string {
	const root = resolve(context.root ?? process.cwd());
	if (
		resolve(context.persist) !== resolve(root, ".wrangler/e2e") ||
		resolve(context.config) !== resolve(root, ".wrangler/e2e-run/wrangler.toml")
	)
		throw new Error("dedicated local L2 runner context required");

	const db = new DatabaseSync(findSqliteFile(context.persist));
	try {
		db.exec("PRAGMA busy_timeout = 5000;");
		const trimmed = sql.trim();
		if (/^(?:SELECT|PRAGMA|WITH)\b/i.test(trimmed) && !trimmed.slice(0, -1).includes(";")) {
			const rows = db.prepare(trimmed).all() as Record<string, unknown>[];
			return JSON.stringify([{ results: rows, success: true }]);
		}
		db.exec(trimmed);
		return JSON.stringify([{ results: [], success: true }]);
	} finally {
		db.close();
	}
}

export function localD1Rows(sql: string): Record<string, unknown>[] {
	const root = resolve(import.meta.dirname, "../..");
	const persist = process.env.GIRAFFE_PERSIST;
	const config = process.env.GIRAFFE_CONFIG;
	if (
		process.env.GIRAFFE_E2E !== "http://127.0.0.1:17045" ||
		persist !== resolve(root, ".wrangler/e2e") ||
		config !== resolve(root, ".wrangler/e2e-run/wrangler.toml")
	)
		throw new Error("dedicated local L2 runner context required");
	const context = { persist, config, root };
	const marker = JSON.parse(
		executeLocalD1Sync("SELECT value FROM _test_marker WHERE key='env'", context),
	) as { results: { value: string }[] }[];
	if (marker[0]?.results[0]?.value !== "test") throw new Error("test database marker required");
	return (
		JSON.parse(executeLocalD1Sync(sql, context)) as { results: Record<string, unknown>[] }[]
	).flatMap((statement) => statement.results);
}
