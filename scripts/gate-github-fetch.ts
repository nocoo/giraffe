import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseSync } from "oxc-parser";

const ALLOW = new Set(["src/server/lib/github-client.ts", "src/server/middleware/access.ts"]);
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
		if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
			acc.push(full);
		}
	}
}

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
	if (!node || typeof node !== "object") {
		return;
	}
	const rec = node as Record<string, unknown>;
	visit(rec);
	for (const value of Object.values(rec)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				walk(item, visit);
			}
		} else {
			walk(value, visit);
		}
	}
}

function collectFetchAliases(root: unknown): Set<string> {
	const aliases = new Set(["fetch"]);
	walk(root, (node) => {
		if (node.type === "VariableDeclarator") {
			const id = node.id as Record<string, unknown> | undefined;
			const init = node.init as Record<string, unknown> | undefined;
			if (id?.type === "Identifier" && init?.type === "Identifier" && init.name === "fetch") {
				aliases.add(String(id.name));
			}
			if (id?.type === "ObjectPattern" && Array.isArray(id.properties)) {
				for (const prop of id.properties) {
					const p = prop as Record<string, unknown>;
					const key = p.key as Record<string, unknown> | undefined;
					const value = p.value as Record<string, unknown> | undefined;
					if (key?.name === "fetch" && value?.type === "Identifier") {
						aliases.add(String(value.name));
					}
				}
			}
		}
	});
	return aliases;
}

function fetchKind(node: Record<string, unknown>, aliases: Set<string>): string | undefined {
	if (node.type !== "CallExpression") {
		return undefined;
	}
	const callee = node.callee as Record<string, unknown> | undefined;
	if (!callee) {
		return undefined;
	}
	if (callee.type === "Identifier" && typeof callee.name === "string" && aliases.has(callee.name)) {
		return callee.name;
	}
	if (callee.type === "MemberExpression") {
		const obj = callee.object as Record<string, unknown> | undefined;
		const prop = callee.property as Record<string, unknown> | undefined;
		if (prop?.name === "fetch" && (obj?.name === "self" || obj?.name === "globalThis")) {
			return `${String(obj.name)}.fetch`;
		}
	}
	return undefined;
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
		const kind = fetchKind(node, aliases);
		if (kind) {
			console.error(`${rel}: forbidden ${kind}`);
			failed = true;
		}
	});
}

if (failed) {
	process.exit(1);
}
console.log("gate:github-fetch passed");
