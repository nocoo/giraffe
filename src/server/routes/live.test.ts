import { describe, expect, it } from "vitest";
import { APP_VERSION } from "../../lib/version";
import type { Env } from "../env";
import { createDb } from "../lib/db/d1";
import { openSqliteD1 } from "../lib/db/sqlite-d1";
import { liveResponse } from "./live";

describe("liveResponse", () => {
	it("reads the d1 marker and stays null without the table", async () => {
		const env = {
			DB: openSqliteD1(true),
			ASSETS: { fetch: () => Promise.reject(new Error("no")) } as unknown as Fetcher,
			TOKEN_ENCRYPTION_KEY_CURRENT: "1",
			ENVIRONMENT: "development",
		} satisfies Env;
		const res = await liveResponse(env, createDb(env.DB));
		expect(await res.json()).toEqual({
			name: "giraffe",
			version: APP_VERSION,
			environment: "development",
			d1_marker: "test",
		});
		const empty = await liveResponse(env, createDb(openSqliteD1(false)));
		expect(((await empty.json()) as { d1_marker: string | null }).d1_marker).toBeNull();
		const throwing = {
			statements: 0,
			prepare: () => {
				throw new Error("no d1");
			},
			batch: async () => [],
		};
		const failed = await liveResponse(env, throwing as unknown as ReturnType<typeof createDb>);
		expect(((await failed.json()) as { d1_marker: string | null }).d1_marker).toBeNull();
	});
});
