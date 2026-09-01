import { hasApiRoutes } from "./has-api-routes";

if (!(await hasApiRoutes())) {
	console.log("L2 N/A: no /api routes yet");
	process.exit(0);
}

console.error("L2 runner for live /api routes is not implemented yet");
process.exit(1);
