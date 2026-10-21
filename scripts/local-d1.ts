import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerBin = join(root, "node_modules/.bin/wrangler");
const schema = join(root, "apps/web/src/server/lib/db/schema.sql");

function d1(args: string[]): string {
	return execFileSync(wranglerBin, ["d1", "execute", "giraffe-db", "--local", ...args], {
		cwd: root,
		encoding: "utf8",
	});
}

function ensureBaseSchema(): void {
	const stdout = d1([
		"--command",
		"SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'",
		"--json",
	]);
	const start = stdout.indexOf("[");
	if (start < 0) {
		d1([`--file=${schema}`]);
		return;
	}
	const parsed = JSON.parse(stdout.slice(start)) as Array<{ results?: Array<{ name?: string }> }>;
	const rows = parsed[0]?.results ?? [];
	if (!rows.some((row) => row.name === "accounts")) {
		d1([`--file=${schema}`]);
	}
}

export function ensureLocalSchema(): void {
	ensureBaseSchema();
	const migrations = join(root, "migrations");
	for (const file of readdirSync(migrations)
		.filter((name) => name.endsWith(".sql"))
		.sort()) {
		if (file === "0014_source_content.sql") {
			const stdout = d1([
				"--command",
				"SELECT COUNT(*) AS migrated FROM (SELECT name FROM pragma_table_info('snapshots') WHERE name='content_meta' UNION ALL SELECT name FROM pragma_table_info('factory_resources') WHERE name='content_meta')",
				"--json",
			]);
			const result = JSON.parse(stdout.slice(stdout.indexOf("["))) as Array<{
				results: Array<{ migrated: number }>;
			}>;
			const migrated = result[0]?.results[0]?.migrated;
			if (migrated === 2) continue;
			if (migrated !== 0) throw new Error("Partial source content migration");
		}
		d1([`--file=${join(migrations, file)}`]);
	}
}
