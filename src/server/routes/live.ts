import { APP_VERSION } from "../../lib/version";
import { type Env, envMode } from "../env";
import type { Db } from "../lib/db/d1";
import { jsonOk } from "../lib/errors";

export async function liveResponse(env: Env, db: Db): Promise<Response> {
	let marker: string | null = null;
	try {
		const row = await db
			.prepare("SELECT value FROM _test_marker WHERE key = ?")
			.bind("env")
			.first<{ value: string }>();
		if (row?.value === "test") {
			marker = "test";
		}
	} catch {
		marker = null;
	}
	return jsonOk({
		name: "giraffe",
		version: APP_VERSION,
		environment: envMode(env.ENVIRONMENT),
		d1_marker: marker,
	});
}
