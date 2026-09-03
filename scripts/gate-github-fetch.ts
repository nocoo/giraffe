import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseSync } from "oxc-parser";
import { collectFetchAliases, isFetchCall, walk } from "./fetch-ast";

const ALLOW = new Set([
	"src/server/lib/github-client.ts",
	"src/server/middleware/access.ts",
	"src/server/lib/author-profile.ts",
]);
const ROOTS = ["src/server", "src/lib"];

async function collect(dir: string, acc: string[]): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const full = join(dir, String(entry.name));
		if (entry.isDirectory()) {
			await collect(full, acc);
			continue;
		}
		const name = String(entry.name);
		if ((name.endsWith(".ts") || name.endsWith(".tsx")) && !name.includes(".test.")) {
			acc.push(full);
		}
	}
}

const files: string[] = [];
for (const root of ROOTS) {
	await collect(root, files);
}

let failed = false;
for (const file of files) {
	const rel = relative(".", file).replaceAll("\\", "/");
	if (ALLOW.has(rel)) {
		continue;
	}
	const text = await readFile(file, "utf8");
	const parsed = parseSync(file, text);
	const aliases = collectFetchAliases(parsed.program);
	walk(parsed.program, (node) => {
		if (isFetchCall(node, aliases)) {
			console.error(`${rel}: forbidden fetch`);
			failed = true;
		}
	});
}

if (failed) {
	process.exit(1);
}
console.log("gate:github-fetch passed");
