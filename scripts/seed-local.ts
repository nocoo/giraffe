import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLocalSchema } from "./local-d1";
import { buildLocalSeedSql } from "./seed-local-data";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const d1Dir = join(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");

function findLocalSqlitePath(): string {
	const files = readdirSync(d1Dir).filter(
		(name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
	);
	const target = files[0];
	if (!target) {
		throw new Error(`No local D1 sqlite database found in ${d1Dir}`);
	}
	return join(d1Dir, target);
}

export function seedLocalDemo(options: { force?: boolean } = {}): boolean {
	const db = new Database(findLocalSqlitePath());
	try {
		db.exec("PRAGMA foreign_keys = ON;");
		const row = db.query("SELECT COUNT(*) AS count FROM accounts").get() as {
			count?: number;
		} | null;
		if (!options.force && (row?.count ?? 0) > 0) {
			return false;
		}
		const sql = buildLocalSeedSql();
		db.transaction(() => {
			if (options.force) {
				db.exec("DELETE FROM accounts;");
			}
			db.exec(sql);
		})();
		return true;
	} finally {
		db.close();
	}
}

export function seedLocalDemoIfEmpty(): void {
	if (seedLocalDemo({ force: false })) {
		console.log("Seeded local D1 with anonymized 36-repo demo data.");
	}
}

if (import.meta.main) {
	const force = process.argv.includes("--force");
	ensureLocalSchema();
	const seeded = seedLocalDemo({ force });
	console.log(
		seeded
			? "Seeded local D1 with anonymized 36-repo demo data."
			: "Local D1 already has account data; pass --force to replace it with demo data.",
	);
}
