import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function revisionFixture(revision: string) {
	const folder = mkdtempSync(join(tmpdir(), "giraffe-revision-"));
	try {
		const archive = execFileSync(
			"git",
			[
				"archive",
				"--format=tar",
				revision,
				"apps/web/src",
				"apps/web/package.json",
				"package.json",
			],
			{ maxBuffer: 16 * 1024 * 1024 },
		);
		execFileSync("tar", ["-x", "-C", folder], { input: archive });
		symlinkSync(resolve("node_modules"), join(folder, "node_modules"));
	} catch (error) {
		rmSync(folder, { recursive: true, force: true });
		throw error;
	}
	return {
		load: <T>(file: string): Promise<T> => import(pathToFileURL(join(folder, file)).href),
		close: () => rmSync(folder, { recursive: true, force: true }),
	};
}
