import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const devVars = join(root, ".dev.vars");
const hidden = join(root, `.dev.vars.__hide_${process.pid}`);
if (existsSync(devVars)) {
	renameSync(devVars, hidden);
}
let code = 1;
try {
	const proc = Bun.spawnSync(
		[
			join(root, "node_modules/.bin/wrangler"),
			"types",
			"--check",
			"--include-runtime=false",
			"--env-interface=CloudflareBindings",
		],
		{ cwd: root, stdout: "inherit", stderr: "inherit" },
	);
	code = proc.exitCode ?? 1;
} finally {
	if (existsSync(hidden)) {
		renameSync(hidden, devVars);
	}
}
process.exit(code);
