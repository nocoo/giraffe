import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDevVars } from "./ensure-dev-vars";
import { ensureLocalSchema } from "./local-d1";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerBin = join(root, "node_modules/.bin/wrangler");
const viteBin = join(root, "node_modules/.bin/vite");

ensureDevVars(root);
ensureLocalSchema();

const wrangler = Bun.spawn([wranglerBin, "dev", "--local", "--port", "7046"], {
	cwd: root,
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});
const vite = Bun.spawn([viteBin, "--port", "7045", "--strictPort"], {
	cwd: root,
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});

function stop(): void {
	wrangler.kill();
	vite.kill();
}

process.on("SIGINT", () => {
	stop();
	process.exit(130);
});
process.on("SIGTERM", () => {
	stop();
	process.exit(143);
});

const code = await Promise.race([wrangler.exited, vite.exited]);
stop();
process.exit(code ?? 1);
