import { mkdir, writeFile } from "node:fs/promises";

await mkdir("dist/client", { recursive: true });
await writeFile("dist/client/index.html", "<!doctype html><title>giraffe</title>\n");

const proc = Bun.spawn(["wrangler", "dev", "--local", "--port", "7045"], {
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});
process.exit(await proc.exited);
