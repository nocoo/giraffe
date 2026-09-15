/** Replay a real audit using built assets + local Worker/D1, isolated from daily development. */

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FactorySnapshot } from "../src/lib/factory-types";
import { encryptToken, parseKeyBytes } from "../src/server/lib/token-crypto";

const source = resolve(process.argv[2] ?? ".factory-cache/audit");
const snapshot = JSON.parse(await readFile(`${source}/snapshot.json`, "utf8")) as FactorySnapshot;
const dir = resolve(".factory-cache/preview");
const persist = resolve(".wrangler/factory-preview");
await mkdir(dir, { recursive: true, mode: 0o700 });
const key = Buffer.from(randomBytes(32)).toString("hex");
const id = "local_audit_account_1";

const schema = await readFile("src/server/lib/db/schema.sql", "utf8");
const initSql = schema
	.replaceAll("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")
	.replaceAll("CREATE UNIQUE INDEX ", "CREATE UNIQUE INDEX IF NOT EXISTS ");
const envelope = await encryptToken("offline-preview-no-github-credential", parseKeyBytes(key));
snapshot.account_id = id;
const payloads = [{ kind: "factory", payload: JSON.stringify(snapshot) }];
for (const file of await readdir(source))
	if (file.startsWith("factory%3A") && file.endsWith(".json"))
		payloads.push({
			kind: decodeURIComponent(file.slice(0, -5)),
			payload: await readFile(`${source}/${file}`, "utf8"),
		});
for (const row of payloads)
	if (Buffer.byteLength(row.payload) > 1_500_000)
		throw new Error(`Preview resource exceeds D1 row limit: ${row.kind}`);
await writeFile(`${dir}/init.sql`, initSql, { mode: 0o600 });
// No GitHub credentials in preview. Refresh would require connecting a real account in Settings.
await writeFile(
	`${dir}/preview.vars`,
	`ENVIRONMENT=development\nGITHUB_API_BASE=https://api.github.com\nTOKEN_ENCRYPTION_KEY_CURRENT=1\nTOKEN_ENCRYPTION_KEY_V1=${key}\n`,
	{ mode: 0o600 },
);
const seed = Bun.spawn(
	[
		"bunx",
		"wrangler",
		"d1",
		"execute",
		"giraffe-db",
		"--local",
		"--persist-to",
		persist,
		"--file",
		`${dir}/init.sql`,
	],
	{ stdout: "pipe", stderr: "pipe" },
);
const [, seedError, seedExit] = await Promise.all([
	new Response(seed.stdout).text(),
	new Response(seed.stderr).text(),
	seed.exited,
]);
if (seedExit) throw new Error(`Local preview init failed: ${seedError.slice(0, 200)}`);
// Wrangler initializes the isolated database; parameterized SQLite inserts avoid its
// SQL text splitter's quadratic behavior on large JSON strings. The Worker is stopped here.
let imported = false;
for await (const file of new Bun.Glob("**/*.sqlite").scan({ cwd: persist, absolute: true })) {
	if (file.endsWith("/metadata.sqlite")) continue;
	const db = new Database(file);
	const table = db
		.query("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'")
		.get();
	if (!table) {
		db.close();
		continue;
	}
	db.exec("PRAGMA foreign_keys=ON");
	db.transaction(() => {
		db.query("DELETE FROM accounts WHERE id IN (?, ?)").run(id, "local_audit_account_01");
		db.query(
			"INSERT INTO accounts (id,login,token_ciphertext,token_last4,key_version,capabilities,is_active,created_at,updated_at) VALUES (?,?,?,'demo',1,'{}',1,?,?)",
		).run(id, snapshot.owner, envelope, snapshot.fetched_at, snapshot.fetched_at);
		const insert = db.query(
			"INSERT INTO snapshots (account_id,kind,payload,fetched_at) VALUES (?,?,?,?)",
		);
		for (const row of payloads) insert.run(id, row.kind, row.payload, snapshot.fetched_at);
	})();
	db.close();
	imported = true;
	break;
}
if (!imported) throw new Error("Isolated local D1 file not found");
const build = Bun.spawn(["bun", "run", "build"], { stdout: "inherit", stderr: "inherit" });
if (await build.exited) throw new Error("Preview build failed");
const worker = Bun.spawn(
	[
		"bunx",
		"wrangler",
		"dev",
		"--local",
		"--persist-to",
		persist,
		"--env-file",
		`${dir}/preview.vars`,
		"--port",
		"7045",
	],
	{ stdout: "inherit", stderr: "inherit" },
);
const stop = () => {
	worker.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log(
	"Real audit preview: http://localhost:7045/factory (or https://giraffe.dev.hexly.ai/factory). Isolated local D1; no GitHub credentials.",
);
const code = await worker.exited;
stop();
process.exitCode = code;
