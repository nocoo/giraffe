import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FALLBACK = [
	"ENVIRONMENT=development",
	"GITHUB_API_BASE=https://api.github.com",
	"TOKEN_ENCRYPTION_KEY_CURRENT=1",
	"TOKEN_ENCRYPTION_KEY_V1=",
	"",
].join("\n");

export function ensureDevVars(root: string): void {
	const dest = join(root, ".dev.vars");
	if (existsSync(dest)) {
		return;
	}
	const example = join(root, "dev.vars.example");
	let body = existsSync(example) ? readFileSync(example, "utf8") : FALLBACK;
	if (!/TOKEN_ENCRYPTION_KEY_V1=[0-9a-fA-F]{64}\s*$/m.test(body)) {
		const key = randomBytes(32).toString("hex");
		if (/^TOKEN_ENCRYPTION_KEY_V1=.*$/m.test(body)) {
			body = body.replace(/^TOKEN_ENCRYPTION_KEY_V1=.*$/m, `TOKEN_ENCRYPTION_KEY_V1=${key}`);
		} else {
			body = `${body.trimEnd()}\nTOKEN_ENCRYPTION_KEY_V1=${key}\n`;
		}
	}
	writeFileSync(dest, body.endsWith("\n") ? body : `${body}\n`);
}
