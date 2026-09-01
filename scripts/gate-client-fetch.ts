import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseSync } from "oxc-parser";

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
		if (
			(name.endsWith(".ts") || name.endsWith(".tsx")) &&
			!name.endsWith(".test.ts") &&
			!name.endsWith(".test.tsx")
		) {
			acc.push(full);
		}
	}
}

function isFetchCall(node: Record<string, unknown>): boolean {
	if (node.type !== "CallExpression") {
		return false;
	}
	const callee = node.callee as Record<string, unknown> | undefined;
	if (!callee) {
		return false;
	}
	if (callee.type === "Identifier" && callee.name === "fetch") {
		return true;
	}
	if (callee.type === "MemberExpression") {
		const obj = callee.object as Record<string, unknown> | undefined;
		const prop = callee.property as Record<string, unknown> | undefined;
		return prop?.name === "fetch" && (obj?.name === "self" || obj?.name === "globalThis");
	}
	return false;
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

const files: string[] = [];
await collect("src/client", files);

let failed = false;
for (const file of files) {
	const rel = relative(".", file).replaceAll("\\", "/");
	const text = await readFile(file, "utf8");
	const parsed = parseSync(file, text);
	walk(parsed.program, (node) => {
		if (!isFetchCall(node)) {
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
