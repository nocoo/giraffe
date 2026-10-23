import { afterEach, expect, it, vi } from "vitest";
import { rawRepo } from "../../../../../tests/fixtures/factory";
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

it.each(["graphql", 403, 404, 500] as const)(
	"retains the calendar and continues repository work after a terminal type-batch failure (%s)",
	async (failure) => {
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
			.bind(
				snapshot.account_id,
				await encryptToken("fake", parseKeyBytes("0".repeat(64))),
				now,
				now,
			)
			.run();
		await db.batch(
			await replaceSnapshotStmts(db, snapshot.account_id, "factory", { ...snapshot }, old),
		);
		await db.batch(
			await replaceSnapshotStmts(
				db,
				snapshot.account_id,
				"repos",
				{ repos: [{ name_with_owner: "nocoo/app" }] },
				now,
			),
		);
		const run = makeRun(
			"daily",
			snapshot.account_id,
			"nocoo",
			"key",
			"refresh",
			snapshot.repos,
			now,
			[],
			[],
			{ scope: "selected" },
			"quick",
			true,
		);
		run.steps = run.steps.filter((step) => step.kind !== "snapshot");
		await startRun(createDb(env.DB), run);
		let typeCalls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (String(init.body).includes("day0:")) {
					typeCalls++;
					if (failure !== "graphql")
						return Response.json({ message: "fixture failure" }, { status: failure });
					return Response.json({
						data: { user: null },
						errors: [{ type: "FORBIDDEN", path: ["user"] }],
					});
				}
				if (String(init.body).includes("openPrs:"))
					return Response.json({ data: { repository: rawRepo } });
				if (String(init.body).includes("object(expression"))
					return Response.json({ data: { repository: {} } });
				if (!url.endsWith("/graphql"))
					return Response.json(url.includes("/actions/runs") ? { workflow_runs: [] } : []);
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
		const first = (await getRun(createDb(env.DB), snapshot.account_id, run.id))?.run;
		expect(first?.checkpoint?.contributionStatus).toBe(failure === 500 ? "pending" : "unavailable");
		expect(typeCalls).toBe(1);
		expect((await publishedFactory(createDb(env.DB), snapshot.account_id))?.contribution).toEqual(
			snapshot.contribution,
		);
		for (let attempt = 0; attempt < (failure === 500 ? 3 : 0); attempt++) {
			const pending = (await getRun(db, snapshot.account_id, run.id))?.run;
			if (!pending) throw new Error("missing retry run");
			expect(pending.steps[0]).toMatchObject({ status: "pending", retryFailures: attempt + 1 });
			expect(Date.parse(pending.nextAttemptAt)).toBeGreaterThan(Date.parse(now));
			await executeRunPage(env, run.id, () => pending.nextAttemptAt);
		}
		const terminal = (await getRun(db, snapshot.account_id, run.id))?.run;
		expect(terminal?.steps[0]?.status).toBe(failure === 500 ? "failed" : "unavailable");
		expect(terminal?.checkpoint?.contributionStatus).toBe("unavailable");
		for (let page = 0; page < 20; page++) {
			const pending = (await getRun(db, snapshot.account_id, run.id))?.run;
			if (!pending) throw new Error("missing continuation run");
			if (pending.status !== "running") break;
			await executeRunPage(env, run.id, () => pending.nextAttemptAt);
		}
		expect(typeCalls).toBe(failure === 500 ? 4 : 1);
		const finished = (await getRun(db, snapshot.account_id, run.id))?.run;
		const repositorySteps = finished?.steps.filter((step) => step.repo) ?? [];
		expect(repositorySteps.length).toBeGreaterThan(0);
		expect(repositorySteps.every((step) => step.status === "success")).toBe(true);
		expect(finished?.status).toBe(failure === 500 ? "partial" : "completed");
		const publication = await publishedFactory(createDb(env.DB), snapshot.account_id);
		expect(publication?.runId).toBe(run.id);
		expect(publication?.contributionStatus).toBe("unavailable");
		expect(publication?.contribution).toEqual(snapshot.contribution);
		expect(publication?.contributionObservation).toEqual(snapshot.contributionObservation);
		expect(publication?.window).toEqual(run.window);
	},
);
