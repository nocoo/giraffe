import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseSync } from "oxc-parser";
import { exportedApiBindings, importSpecs, isApiPath, sourceHasApiRoutes } from "./api-route-ast";

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

export function resolveImport(fromFile: string, spec: string, root = "."): string {
	const base = spec.startsWith("@/")
		? resolve(root, "src", spec.slice(2))
		: resolve(dirname(fromFile), spec);
	if (base.endsWith(".ts")) {
		return base;
	}
	return `${base}.ts`;
}

export async function hasApiRoutes(root = "."): Promise<boolean> {
	const routed: string[] = [];
	await collect(join(root, "src/server/routes"), routed);
	if (routed.length > 0) {
		return true;
	}
	const files: string[] = [];
	await collect(join(root, "src/server"), files);
	const exportFiles: string[] = [...files];
	await collect(join(root, "src/lib"), exportFiles);
	const programs = new Map<string, unknown>();
	const exports = new Map<string, Map<string, string>>();
	for (const file of exportFiles) {
		const text = await readFile(file, "utf8");
		const program = parseSync(file, text).program;
		programs.set(resolve(file), program);
		exports.set(resolve(file), exportedApiBindings(program));
	}
	for (const file of files) {
		const abs = resolve(file);
		const program = programs.get(abs);
		if (!program) {
			continue;
		}
		const extra = new Set<string>();
		for (const spec of importSpecs(program)) {
			const target = resolveImport(abs, spec.from, root);
			const exported = exports.get(target)?.get(spec.imported);
			if (exported && isApiPath(exported)) {
				extra.add(spec.local);
			}
		}
		if (sourceHasApiRoutes(program, extra)) {
			return true;
		}
	}
	return false;
}
