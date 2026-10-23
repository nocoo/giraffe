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
	const legacyColumns = Object.fromEntries(
		["accounts", "snapshots", "snapshot_days"].map((table) => [
			table,
			(db.query(`PRAGMA table_info(${table})`).all() as { name: string }[])
				.map(({ name }) => `"${name}"`)
				.join(","),
		]),
	);
	const digest = () =>
		Object.fromEntries(
			["accounts", "snapshots", "snapshot_days"].map((table) => [
				table,
				createHash("sha256")
					.update(
						JSON.stringify(
							db.query(`SELECT ${legacyColumns[table]} FROM ${table} ORDER BY 1,2`).all(),
						),
					)
					.digest("hex"),
			]),
		);
	const before = digest();
	const migrations = readdirSync("migrations")
		.filter((name) => name.endsWith(".sql"))
		.sort()
		.map((name) => ({ name, sql: readFileSync(`migrations/${name}`, "utf8") }));
	const migration = migrations.map(({ sql }) => sql).join("\n");
	if (!readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8").endsWith(migration))
		throw new Error("Initial schema and migration disagree");
	for (let pass = 0; pass < 2; pass++)
		for (const { name, sql } of migrations) {
			if (name === "0014_source_content.sql") {
				const migrated = ["snapshots", "factory_resources"].map((table) =>
					Boolean(
						db.query(`SELECT 1 FROM pragma_table_info('${table}') WHERE name='content_meta'`).get(),
					),
				);
				if (migrated.every(Boolean)) continue;
				if (migrated.some(Boolean)) throw new Error("Partial source content migration");
			}
			if (name === "0017_star_provenance.sql") {
				const migrated = ["starred", "source", "updated_at", "reason"].map((column) =>
					Boolean(
						db.query("SELECT 1 FROM pragma_table_info('repo_stars') WHERE name=?").get(column),
					),
				);
				if (migrated.every(Boolean)) continue;
				if (migrated.some(Boolean)) throw new Error("Partial star provenance migration");
			}
			if (name === "0020_catalog_identity_safety.sql") {
				const tables = ["catalog_displaced_state", "catalog_unconfirmed"];
				const column = db
					.query(
						"SELECT 1 FROM pragma_table_info('catalog_repositories') WHERE name='name_current' AND type='INTEGER' AND \"notnull\"=1 AND dflt_value='1'",
					)
					.get();
				const present = tables.map((table) =>
					Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)),
				);
				if (column || present.some(Boolean)) {
					const expected = new Database(":memory:");
					try {
						expected.exec(readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8"));
						for (const object of [
							"catalog_repositories",
							...tables,
							"catalog_current_name",
							"catalog_unconfirmed_cursor",
						]) {
							const actual = db.query("SELECT sql FROM sqlite_master WHERE name=?").get(object);
							const wanted = expected
								.query("SELECT sql FROM sqlite_master WHERE name=?")
								.get(object);
							if (!actual || JSON.stringify(actual) !== JSON.stringify(wanted))
								throw new Error("Partial catalog identity safety migration");
						}
					} finally {
						expected.close();
					}
					continue;
				}
			}
			db.exec(sql);
		}
	const required = [
		"factory_run_journal",
		"factory_runs",
		"factory_state",
		"factory_resources",
		"factory_repo_versions",
		"factory_repo_state",
		"factory_version_refs",
		"factory_storage",
		"factory_budget",
		"activity_publications",
		"activity_pages",
		"catalog_repositories",
		"catalog_changes",
		"catalog_state",
		"catalog_displaced_state",
		"catalog_unconfirmed",
		"repo_stars",
		"refresh_schedules",
		"catalog_refresh_schedules",
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
	for (const index of ["snapshots_content", "factory_resources_content"])
		if (!db.query("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(index))
			throw new Error("Source content index missing");
	for (const column of ["starred", "source", "updated_at", "reason"])
		if (!db.query("SELECT 1 FROM pragma_table_info('repo_stars') WHERE name=?").get(column))
			throw new Error("Star provenance column missing");
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
			.run(probe, probe).changes < 1
	)
		throw new Error("Valid fenced mutation failed");
	db.query(
		"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,'probe/repo','commits','{}')",
	).run(probe);
	const size = db.query("SELECT bytes FROM factory_storage WHERE account_id=?").get(probe) as {
		bytes: number;
	};
	if (size.bytes !== 2) throw new Error("Resource accounting failed");
	db.query("INSERT INTO factory_repo_versions VALUES(?,'probe/repo',?,'{}','2000')").run(
		probe,
		probe,
	);
	db.query("INSERT INTO factory_repo_state VALUES(?,'probe/repo',?,'{}')").run(probe, probe);
	db.query(
		"INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES(?,?,'{\"repos\":[]}','2000')",
	).run(probe, `factory:v:${probe}`);
	db.query("INSERT INTO factory_version_refs VALUES(?,?,'probe/repo',?,'run')").run(
		probe,
		probe,
		probe,
	);
	db.query("INSERT INTO factory_state VALUES(?,?,NULL,'2000')").run(probe, probe);
	const budgetBefore = (
		db.query("SELECT bytes FROM factory_budget WHERE account_id=?").get(probe) as { bytes: number }
	).bytes;
	db.query(
		"INSERT INTO activity_publications(account_id,run_id,until_at,fetched_at,payload,content_version) VALUES(?,?,'2000','2000','{}','fixture')",
	).run(probe, probe);
	db.query("INSERT INTO activity_pages VALUES(?,?,0,'[]')").run(probe, probe);
	const budgetAfter = (
		db.query("SELECT bytes FROM factory_budget WHERE account_id=?").get(probe) as { bytes: number }
	).bytes;
	if (budgetAfter - budgetBefore !== 4) throw new Error("Activity byte accounting failed");
	db.query("DELETE FROM activity_publications WHERE account_id=?").run(probe);
	if (
		(
			db.query("SELECT COUNT(*) AS n FROM activity_pages WHERE account_id=?").get(probe) as {
				n: number;
			}
		).n !== 0
	)
		throw new Error("Activity page cascade failed");

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
