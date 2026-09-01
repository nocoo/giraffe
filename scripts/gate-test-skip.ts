import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOTS = ["src", "tests"];
const PATTERN =
	/\.(?:only|skip|todo|fails|runIf|skipIf)\b|\b(?:xtest|xdescribe|it\.todo|test\.concurrent\.todo)\b/;

async function collect(dir: string, acc: string[]): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const full = join(dir, String(entry.name));
		if (entry.isDirectory()) {
			await collect(full, acc);
			continue;
		}
		const name = String(entry.name);
		if (name.endsWith(".ts") || name.endsWith(".tsx")) {
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
	const text = await readFile(file, "utf8");
	for (const [index, line] of text.split("\n").entries()) {
		if (PATTERN.test(line)) {
			console.error(`${file}:${index + 1}: skipped or focused test`);
			failed = true;
		}
	}
}

if (failed) {
	process.exit(1);
}
console.log("gate:test-skip passed");
