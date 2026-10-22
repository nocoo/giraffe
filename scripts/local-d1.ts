import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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
		if (file === "0017_star_provenance.sql") {
			const stdout = d1([
				"--command",
				"SELECT COUNT(*) AS migrated FROM pragma_table_info('repo_stars') WHERE name IN ('starred','source','updated_at','reason')",
				"--json",
			]);
			const result = JSON.parse(stdout.slice(stdout.indexOf("["))) as Array<{
				results: Array<{ migrated: number }>;
			}>;
			const migrated = result[0]?.results[0]?.migrated;
			if (migrated === 4) continue;
			if (migrated !== 0) throw new Error("Partial star provenance migration");
		}
		if (file === "0020_catalog_identity_safety.sql") {
			const stdout = d1([
				"--command",
				"SELECT 'name_current' AS name,CASE WHEN type='INTEGER' AND \"notnull\"=1 AND dflt_value='1' THEN 'valid' ELSE 'invalid' END AS sql FROM pragma_table_info('catalog_repositories') WHERE name='name_current' UNION ALL SELECT name,sql FROM sqlite_master WHERE name IN ('catalog_displaced_state','catalog_unconfirmed','catalog_current_name','catalog_unconfirmed_cursor')",
				"--json",
			]);
			const result = JSON.parse(stdout.slice(stdout.indexOf("["))) as Array<{
				results: { name: string; sql: string }[];
			}>;
			const objects = new Map(result[0]?.results.map((row) => [row.name, row.sql]));
			if (
				objects.has("name_current") ||
				objects.has("catalog_displaced_state") ||
				objects.has("catalog_unconfirmed")
			) {
				const normalize = (sql: string) =>
					sql
						.replace(/IF NOT EXISTS/g, "")
						.replace(/\s+/g, "")
						.replace(/;$/, "");
				const definitions =
					readFileSync(join(migrations, file), "utf8").match(
						/CREATE (?:TABLE|UNIQUE INDEX|INDEX)[^;]+;/g,
					) ?? [];
				if (
					objects.get("name_current") !== "valid" ||
					definitions.length !== 4 ||
					!definitions.every((definition) => {
						const name = /IF NOT EXISTS (\w+)/.exec(definition)?.[1];
						return name && normalize(objects.get(name) ?? "") === normalize(definition);
					})
				)
					throw new Error("Partial catalog identity safety migration");
				continue;
			}
		}
		d1([`--file=${join(migrations, file)}`]);
	}
}
