import { afterEach, expect, it, vi } from "vitest";
import { rawEvent, ready } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import type { Env } from "../env";
import { createDb } from "./db/d1";
import { getRun, startRun } from "./db/factory-runs";
import { executeRunPage } from "./factory-execute";
import { encryptToken, parseKeyBytes } from "./token-crypto";

afterEach(() => vi.unstubAllGlobals());

it("retains spent REST budget when the PR details batch fails and the page rolls back", async () => {
	const now = new Date().toISOString();
	const reset = new Date(Math.ceil(Date.now() / 1000) * 1000 + 3600_000).toISOString();
	const checkpoint = ready("prs");
	const env = {
		DB: sqliteFixture(),
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
		TOKEN_ENCRYPTION_KEY_V1: "0".repeat(64),
	} as unknown as Env;
	const db = createDb(env.DB);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo',?,'fake',?,?)",
		)
		.bind(
			checkpoint.account_id,
			await encryptToken("fake", parseKeyBytes("0".repeat(64))),
			now,
			now,
		)
		.run();
	const run = makeRun(
		"rate-run",
		checkpoint.account_id,
		"nocoo",
		"key",
		"refresh",
		checkpoint.repos,
		now,
	);
	run.steps = run.steps.filter((step) => step.kind === "prs");
	run.checkpoint = checkpoint;
	await startRun(db, run);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) =>
			url.endsWith("/graphql")
				? Response.json({}, { status: 429 })
				: Response.json([rawEvent()], {
						headers: {
							"x-ratelimit-remaining": "49",
							"x-ratelimit-reset": String(Date.parse(reset) / 1000),
						},
					}),
		),
	);
	await executeRunPage(env, run.id, () => now);
	const saved = (await getRun(db, run.account_id, run.id))?.run;
	expect(saved?.checkpoint?.rateLimits?.core).toMatchObject({ remaining: 49, resetAt: reset });
	expect(saved?.checkpoint?.repos[0]?.coverage.prs.status).toBe("pending");
	expect(saved?.steps[0]).toMatchObject({ status: "pending", error: "github_rate_limited" });
	expect(saved?.nextAttemptAt).toBe(reset);
	expect((await db.prepare("SELECT * FROM factory_resources").all()).results).toEqual([]);
});
