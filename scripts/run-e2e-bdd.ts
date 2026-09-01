import { existsSync } from "node:fs";

if (!existsSync("src/client")) {
	console.log("L3 N/A: phase 1 has no client");
	process.exit(0);
}

console.error("L3 runner is not implemented yet");
process.exit(1);
