import { afterEach, expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import type { Env } from "../env";
import { createDb } from "./db/d1";
import { getRun, publishedFactory, startRun } from "./db/factory-runs";
import { replaceSnapshotStmts } from "./db/snapshots";
import { executeRunPage } from "./factory-execute";
import { encryptToken, parseKeyBytes } from "./token-crypto";

afterEach(() => vi.unstubAllGlobals());

it("retains the exact last good calendar and original source window after a resumed type batch loses access", async () => {
	const snapshot = factoryFixture();
	const now = snapshot.fetched_at;
	const old = "2026-09-14T12:00:00.000Z";
	snapshot.contribution = {
		total: 3,
		restricted: 1,
		fetchedAt: old,
		days: [
			{
				date: "2026-09-14",
				count: 3,
				types: {
					commits: 1,
					issues: 0,
					pullRequests: 1,
					pullRequestReviews: 0,
					repositories: 0,
					restricted: 1,
				},
				breakdown: "complete",
			},
		],
	};
	snapshot.contributionStatus = "complete";
	snapshot.contributionObservation = {
		version: "old-calendar",
		fetchedAt: old,
		window: { since: "2026-06-17T00:00:00.000Z", until: old },
	};
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
		.bind(snapshot.account_id, await encryptToken("fake", parseKeyBytes("0".repeat(64))), now, now)
		.run();
	await db.batch(replaceSnapshotStmts(db, snapshot.account_id, "factory", { ...snapshot }, old));
	const run = makeRun(
		"daily",
		snapshot.account_id,
		"nocoo",
		"key",
		"refresh",
		[],
		now,
		[],
		[],
		{ scope: "selected" },
		"quick",
		true,
	);
	run.steps = run.steps.filter((step) => ["contributions", "publish"].includes(step.kind));
	await startRun(createDb(env.DB), run);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init: RequestInit) => {
			if (String(init.body).includes("day0:"))
				return Response.json({
					data: { user: null },
					errors: [{ type: "FORBIDDEN", path: ["user"] }],
				});
			return Response.json({
				data: {
					user: {
						contributionsCollection: {
							restrictedContributionsCount: 0,
							contributionCalendar: {
								totalContributions: 0,
								weeks: [
									{
										contributionDays: Array.from({ length: 90 }, (_, index) => ({
											date: new Date(Date.parse(run.window.since) + index * 86400_000)
												.toISOString()
												.slice(0, 10),
											contributionCount: 0,
										})),
									},
								],
							},
						},
					},
				},
			});
		}),
	);
	await executeRunPage(env, run.id, () => now);
	expect(
		(await getRun(createDb(env.DB), snapshot.account_id, run.id))?.run.checkpoint
			?.contributionStatus,
	).toBe("pending");
	expect((await publishedFactory(createDb(env.DB), snapshot.account_id))?.contribution).toEqual(
		snapshot.contribution,
	);
	await executeRunPage(env, run.id, () => now);
	expect((await getRun(createDb(env.DB), snapshot.account_id, run.id))?.run.steps[0]).toMatchObject(
		{ status: "unavailable", error: "coverage_unavailable" },
	);
	await executeRunPage(env, run.id, () => now);
	const publication = await publishedFactory(createDb(env.DB), snapshot.account_id);
	expect(publication?.runId).toBe(run.id);
	expect(publication?.contributionStatus).toBe("unavailable");
	expect(publication?.contribution).toEqual(snapshot.contribution);
	expect(publication?.contributionObservation).toEqual(snapshot.contributionObservation);
	expect(publication?.window).toEqual(run.window);
});
