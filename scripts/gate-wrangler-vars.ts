import { readFile } from "node:fs/promises";

const text = await readFile("wrangler.toml", "utf8");
const checks: Array<[RegExp, string]> = [
	[/\bGITHUB_API_BASE\b/, "GITHUB_API_BASE"],
	[/\bACCESS_JWKS_URL\b/, "ACCESS_JWKS_URL"],
	[/\bENVIRONMENT\s*=\s*["']development["']/, 'ENVIRONMENT = "development"'],
	[/\bENVIRONMENT\s*=\s*["']test["']/, 'ENVIRONMENT = "test"'],
];

let failed = false;
for (const [pattern, label] of checks) {
	if (pattern.test(text)) {
		console.error(`wrangler.toml must not contain ${label}`);
		failed = true;
	}
}
if (failed) {
	process.exit(1);
}
console.log("gate:wrangler-vars passed");
