import { resolve } from "node:path";
import { executeD1FixtureSync } from "../fixtures/d1";

export const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

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
		executeD1FixtureSync("SELECT value FROM _test_marker WHERE key='env'", context),
	) as { results: { value: string }[] }[];
	if (marker[0]?.results[0]?.value !== "test") throw new Error("test database marker required");
	return (
		JSON.parse(executeD1FixtureSync(sql, context)) as { results: Record<string, unknown>[] }[]
	).flatMap((statement) => statement.results);
}
