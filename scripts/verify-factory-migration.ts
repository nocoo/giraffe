import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

const backup = process.argv[2];
if (!backup)
	throw new Error("Usage: bun scripts/verify-factory-migration.ts <local D1 SQL export>");
const db = new Database(":memory:");
try {
	db.exec(readFileSync(backup, "utf8"));
	db.exec("PRAGMA foreign_keys=ON");
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
	const migration = readdirSync("migrations")
		.filter((name) => name.endsWith(".sql"))
		.sort()
		.map((name) => readFileSync(`migrations/${name}`, "utf8"))
		.join("\n");
	if (!readFileSync("src/server/lib/db/schema.sql", "utf8").endsWith(migration))
		throw new Error("Initial schema and migration disagree");
	db.exec(migration);
	db.exec(migration);
	const required = [
		"factory_runs",
		"factory_state",
		"factory_resources",
		"factory_repo_versions",
		"factory_repo_state",
		"factory_version_refs",
		"factory_storage",
	];
	for (const table of required)
		if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))
			throw new Error("Missing factory table");
	if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("Foreign-key violations");
	const indexes = db.query("PRAGMA index_list(factory_runs)").all() as {
		name: string;
		unique: number;
		partial: number;
	}[];
	if (
		!indexes.some(
			(index) => index.name === "factory_one_active" && index.unique === 1 && index.partial === 1,
		)
	)
		throw new Error("Active-run constraint missing");
	if (!db.query("PRAGMA foreign_key_list(factory_resources)").all().length)
		throw new Error("Resource foreign key missing");
	db.exec("SAVEPOINT factory_probe");
	const probe = crypto.randomUUID();
	db.query(
		"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?, 'noncredential','fake','2000','2000')",
	).run(probe, probe);
	db.query(
		"INSERT INTO factory_runs(id,account_id,request_key,status,payload,lease_token,lease_until,next_at,created_at,updated_at) VALUES(?,?,?,'running',?,?,'2999','2000','2000','2000')",
	).run(probe, probe, probe, JSON.stringify({ cursor: 0, steps: [{ status: "pending" }] }), probe);
	if (
		db
			.query(
				"INSERT OR IGNORE INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) SELECT id||'x',account_id,request_key||'x',status,payload,next_at,created_at,updated_at FROM factory_runs WHERE id=?",
			)
			.run(probe).changes !== 0
	)
		throw new Error("Concurrent-run exclusion failed");
	if (
		db
			.query(
				"UPDATE factory_runs SET payload=json_set(payload,'$.cursor',1) WHERE id=? AND lease_token='wrong'",
			)
			.run(probe).changes !== 0
	)
		throw new Error("Fence failed");
	if (
		db
			.query(
				"UPDATE factory_runs SET payload=json_set(payload,'$.cursor',1) WHERE id=? AND lease_token=? AND version=0 AND status='running'",
			)
			.run(probe, probe).changes !== 1
	)
		throw new Error("Valid fenced mutation failed");
	db.query("INSERT INTO factory_resources VALUES(?,'probe/repo','commits','{}')").run(probe);
	const size = db.query("SELECT bytes FROM factory_storage WHERE account_id=?").get(probe) as {
		bytes: number;
	};
	if (size.bytes !== 2) throw new Error("Resource accounting failed");
	db.query("INSERT INTO factory_repo_versions VALUES(?,'probe/repo',?,'{}','2000')").run(
		probe,
		probe,
	);
	db.query("INSERT INTO factory_repo_state VALUES(?,'probe/repo',?,'{}')").run(probe, probe);
	db.query("INSERT INTO snapshots VALUES(?,?,'{\"repos\":[]}','2000')").run(
		probe,
		`factory:v:${probe}`,
	);
	db.query("INSERT INTO factory_version_refs VALUES(?,?,'probe/repo',?,'run')").run(
		probe,
		probe,
		probe,
	);
	db.query("INSERT INTO factory_state VALUES(?,?,NULL,'2000')").run(probe, probe);
	if (db.query("PRAGMA foreign_key_check").all().length)
		throw new Error("Operational foreign keys failed");
	db.exec("ROLLBACK TO factory_probe; RELEASE factory_probe");
	const after = digest();
	if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Legacy data changed");
	const integrity = db.query("PRAGMA integrity_check").get();
	if (JSON.stringify(integrity) !== '{"integrity_check":"ok"}')
		throw new Error("Database integrity check failed");
	console.log(
		JSON.stringify(
			{
				applied: 2,
				legacyTablesUnchanged: true,
				operationalProbe: true,
				rollbackVerified: true,
				integrity,
				hashes: after,
			},
			null,
			2,
		),
	);
} finally {
	db.close();
}
