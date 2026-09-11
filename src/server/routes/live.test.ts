import { describe, expect, it } from "vitest";
import { APP_VERSION } from "../../lib/version";
import type { Env } from "../env";
import { createDb } from "../lib/db/d1";
import { openSqliteD1 } from "../lib/db/sqlite-d1";
import { liveResponse } from "./live";

describe("liveResponse", () => {
	it("checks D1 while keeping the test marker optional", async () => {
		const env = {
			DB: openSqliteD1(true),
			ASSETS: { fetch: () => Promise.reject(new Error("no")) } as unknown as Fetcher,
			TOKEN_ENCRYPTION_KEY_CURRENT: "1",
			ENVIRONMENT: "development",
		} satisfies Env;
		const res = await liveResponse(env, createDb(env.DB));
		expect(await res.json()).toEqual({
			status: "ok",
			name: "giraffe",
			version: APP_VERSION,
			environment: "development",
			d1_marker: "test",
			database: { connected: true },
		});
		expect(res.headers.get("cache-control")).toBe("no-store");
		const empty = await liveResponse(env, createDb(openSqliteD1(false)));
		expect(empty.status).toBe(200);
		expect(await empty.json()).toMatchObject({
			status: "ok",
			database: { connected: true },
			d1_marker: null,
		});
		const missingMarkerDb = createDb(openSqliteD1(false));
		const prepare = missingMarkerDb.prepare;
		missingMarkerDb.prepare = (sql) => {
			if (sql.includes("_test_marker")) throw new Error("no such table: _test_marker");
			return prepare(sql);
		};
		const missingMarker = await liveResponse(env, missingMarkerDb);
		expect(missingMarker.status).toBe(200);
		expect(await missingMarker.json()).toMatchObject({
			status: "ok",
			database: { connected: true },
			d1_marker: null,
		});
		const throwing = {
			statements: 0,
			prepare: () => {
				throw new Error("private D1 diagnostic");
			},
			batch: async () => [],
		};
		const failed = await liveResponse(env, throwing as unknown as ReturnType<typeof createDb>);
		expect(failed.status).toBe(503);
		expect(failed.headers.get("cache-control")).toBe("no-store");
		expect(await failed.json()).toEqual({
			status: "error",
			name: "giraffe",
			version: APP_VERSION,
			environment: "development",
			database: { connected: false },
			d1_marker: null,
		});
	});

	it.each([null, { n: 0 }])("rejects an invalid D1 probe result: %s", async (row) => {
		const env = {
			DB: openSqliteD1(false),
			ASSETS: { fetch: () => Promise.reject(new Error("no")) } as unknown as Fetcher,
			TOKEN_ENCRYPTION_KEY_CURRENT: "1",
			ENVIRONMENT: "development",
		} satisfies Env;
		const db = {
			statements: 0,
			prepare: () => ({ first: async () => row }),
			batch: async () => [],
		};
		const response = await liveResponse(env, db as unknown as ReturnType<typeof createDb>);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			status: "error",
			database: { connected: false },
		});
	});
});
