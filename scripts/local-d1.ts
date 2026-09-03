import { execFileSync } from "node:child_process";
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

export function ensureLocalSchema(): void {
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
