import { APP_VERSION } from "../../lib/version";
import { type Env, envMode } from "../env";
import type { Db } from "../lib/db/d1";
import { jsonOk } from "../lib/errors";

export async function liveResponse(env: Env, db: Db): Promise<Response> {
	let connected = false;
	try {
		connected = (await db.prepare("SELECT 1 AS n").first<{ n: number }>())?.n === 1;
	} catch {
		// A failed core probe must not expose private diagnostics or report success.
	}
	let marker: string | null = null;
	try {
		if (connected) {
			const row = await db
				.prepare("SELECT value FROM _test_marker WHERE key = ?")
				.bind("env")
				.first<{ value: string }>();
			if (row?.value === "test") {
				marker = "test";
			}
		}
	} catch {
		marker = null;
	}
	return jsonOk(
		{
			status: connected ? "ok" : "error",
			name: "giraffe",
			version: APP_VERSION,
			environment: envMode(env.ENVIRONMENT),
			d1_marker: marker,
			database: { connected },
		},
		connected ? 200 : 503,
		{ "cache-control": "no-store" },
	);
}
