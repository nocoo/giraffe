import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseSync } from "oxc-parser";
import { collectFetchAliases, isFetchCall, walk } from "./fetch-ast";

const ALLOW = "src/client/lib/api.ts";

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

function urlIsApi(node: Record<string, unknown>): boolean {
	const args = node.arguments as unknown[] | undefined;
	const first = args?.[0] as Record<string, unknown> | undefined;
	if (!first) {
		return false;
	}
	if (first.type === "Literal" && typeof first.value === "string") {
		return first.value.startsWith("/api/");
	}
	if (first.type === "TemplateLiteral") {
		const quasis = first.quasis as Array<Record<string, unknown>> | undefined;
		const cooked = (quasis?.[0]?.value as Record<string, unknown> | undefined)?.cooked;
		return typeof cooked === "string" && cooked.startsWith("/api/");
	}
	return false;
}

const files: string[] = [];
await collect("src/client", files);

let failed = false;
for (const file of files) {
	const rel = relative(".", file).replaceAll("\\", "/");
	const text = await readFile(file, "utf8");
	const parsed = parseSync(file, text);
	const aliases = collectFetchAliases(parsed.program);
	walk(parsed.program, (node) => {
		if (!isFetchCall(node, aliases)) {
			return;
		}
		if (rel !== ALLOW) {
			console.error(`${rel}: fetch is only allowed in ${ALLOW}`);
			failed = true;
		} else if (!urlIsApi(node)) {
			console.error(`${rel}: client fetch URL must be a /api/ relative path`);
			failed = true;
		}
	});
}

if (failed) {
	process.exit(1);
}
console.log("gate:client-fetch passed");
