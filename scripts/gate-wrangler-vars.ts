import { readFile } from "node:fs/promises";

const FORBIDDEN = [
	"GITHUB_API_BASE",
	"ACCESS_JWKS_URL",
	"ENVIRONMENT=development",
	"ENVIRONMENT=test",
];

const text = await readFile("wrangler.toml", "utf8");
let failed = false;
for (const token of FORBIDDEN) {
	if (text.includes(token)) {
		console.error(`wrangler.toml must not contain ${token}`);
		failed = true;
	}
}
if (failed) {
	process.exit(1);
}
console.log("gate:wrangler-vars passed");
