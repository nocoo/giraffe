import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSync } from "oxc-parser";
import { sourceHasApiRoutes } from "./api-route-ast";

async function collect(dir: string, acc: string[]): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const full = join(dir, String(entry.name));
		if (entry.isDirectory()) {
			await collect(full, acc);
			continue;
		}
		const name = String(entry.name);
		if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
			acc.push(full);
		}
	}
}

export async function hasApiRoutes(): Promise<boolean> {
	const routed: string[] = [];
	await collect("src/server/routes", routed);
	if (routed.length > 0) {
		return true;
	}
	const files: string[] = [];
	await collect("src/server", files);
	for (const file of files) {
		const text = await readFile(file, "utf8");
		if (sourceHasApiRoutes(parseSync(file, text).program)) {
			return true;
		}
	}
	return false;
}
