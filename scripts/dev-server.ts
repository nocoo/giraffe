import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerBin = join(root, "node_modules/.bin/wrangler");
const schema = join(root, "src/server/lib/db/schema.sql");

function d1(args: string[]): string {
	return execFileSync(wranglerBin, ["d1", "execute", "giraffe-db", "--local", ...args], {
		cwd: root,
		encoding: "utf8",
	});
}

function localAccountsExist(): boolean {
	const stdout = d1([
		"--command",
		"SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'",
		"--json",
	]);
	const start = stdout.indexOf("[");
	if (start < 0) {
		return false;
	}
	const parsed = JSON.parse(stdout.slice(start)) as Array<{ results?: Array<{ name?: string }> }>;
	const rows = parsed[0]?.results ?? [];
	return rows.some((row) => row.name === "accounts");
}

await mkdir("dist/client", { recursive: true });
await writeFile("dist/client/index.html", "<!doctype html><title>giraffe</title>\n");
if (!localAccountsExist()) {
	d1([`--file=${schema}`]);
}

const proc = Bun.spawn([wranglerBin, "dev", "--local", "--port", "7045"], {
	cwd: root,
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});
process.exit(await proc.exited);
