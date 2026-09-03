import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDevVars } from "./ensure-dev-vars";
import { ensureLocalSchema } from "./local-d1";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerBin = join(root, "node_modules/.bin/wrangler");

await mkdir("dist/client", { recursive: true });
await writeFile("dist/client/index.html", "<!doctype html><title>giraffe</title>\n");
ensureDevVars(root);
ensureLocalSchema();

const proc = Bun.spawn([wranglerBin, "dev", "--local", "--port", "7045"], {
	cwd: root,
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});
process.exit(await proc.exited);
