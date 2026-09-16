import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const backup = process.argv[2];
if (!backup)
	throw new Error("Usage: bun scripts/verify-factory-migration.ts <local D1 SQL export>");
const db = new Database(":memory:");
try {
	db.exec(readFileSync(backup, "utf8"));
	const digest = () =>
		Object.fromEntries(
			["accounts", "snapshots", "snapshot_days"].map((table) => [
				table,
				createHash("sha256")
					.update(JSON.stringify(db.query(`SELECT * FROM ${table} ORDER BY 1,2`).all()))
					.digest("hex"),
			]),
		);
	const before = digest();
	const migration = readFileSync("migrations/0001_factory_runs.sql", "utf8");
	if (!readFileSync("src/server/lib/db/schema.sql", "utf8").endsWith(migration))
		throw new Error("Initial schema and migration disagree");
	db.exec(migration);
	db.exec(migration);
	const after = digest();
	if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Legacy data changed");
	const integrity = db.query("PRAGMA integrity_check").get();
	if (JSON.stringify(integrity) !== '{"integrity_check":"ok"}')
		throw new Error("Database integrity check failed");
	console.log(
		JSON.stringify({ applied: 2, legacyTablesUnchanged: true, integrity, hashes: after }, null, 2),
	);
} finally {
	db.close();
}
