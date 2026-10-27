import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rawRepo } from "../../../../../tests/fixtures/factory";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun, RUN_LEASE_MS, type RunSelection } from "../../lib/factory-run";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import type { Env } from "../env";
import { createApp } from "../index";
import * as activityLanded from "./activity-landed";
import { readActivity } from "./activity-store";
import { contentVersion, observationVersion } from "./content-version";
import { createDb } from "./db/d1";
import {
	claimRun,
	controlRun,
	getRun,
	listRuns,
	publishedFactory,
	repoStates,
	saveRun,
	startRun,
} from "./db/factory-runs";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { ApiError } from "./errors";
import { contributionDates } from "./factory-contributions";
import { consumeFactory } from "./factory-dispatch";
import { executeRunPage } from "./factory-execute";
import { FactoryInvocation } from "./factory-invocation";
import { mapFactoryRepo } from "./factory-map";
import * as factoryPublish from "./factory-publish";
import { currentRepo, repositoryWrites } from "./factory-publish";
import { readSources } from "./machine-sources";
import { encryptToken, parseKeyBytes } from "./token-crypto";

const snap = factoryFixture();
const now = snap.fetched_at;
async function setup(
	mode: "refresh" | "catalog" = "refresh",
	selection: RunSelection = { scope: "all" },
	daily = false,
) {
	const env = {
		FACTORY_QUEUE: {} as Queue,
		DB: sqliteFixture(),
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
		TOKEN_ENCRYPTION_KEY_V1: "0".repeat(64),
	} as unknown as Env;
	const db = createDb(env.DB);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?,?,?,?,?)",
		)
		.bind(
			snap.account_id,
			"nocoo",
			await encryptToken("fake", parseKeyBytes("0".repeat(64))),
			"fake",
			now,
			now,
		)
		.run();
	await db
		.prepare("UPDATE accounts SET capabilities=? WHERE id=?")
		.bind(JSON.stringify({ repo: true, notifications: true }), snap.account_id)
		.run();
	await db.batch(await replaceSnapshotStmts(db, snap.account_id, "factory", { ...snap }, now));
	if (mode === "refresh")
		await db.batch(
			await replaceSnapshotStmts(
				db,
				snap.account_id,
				"repos",
				{ repos: snap.repos.map((repo) => ({ name_with_owner: repo.name })) },
				now,
			),
		);
	const run = makeRun(
		"r1",
		snap.account_id,
		"nocoo",
		"k1",
		mode,
		mode === "catalog" ? [] : snap.repos,
		now,
		[],
		snap.repos.map((repo) => repo.name),
		selection,
		daily ? "quick" : "deep",
		daily,
	);
	if (daily) run.trigger = "daily";
	await startRun(db, run);
	return env;
}
beforeEach(() =>
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			if (url.includes("/commits?") && !new URL(url).searchParams.has("since"))
				return Response.json([
					{
						sha: new URL(url).searchParams.get("sha"),
						commit: {
							message: "Previously authored, newly observed",
							committer: { date: "2020-01-01T00:00:00Z" },
						},
					},
				]);
			if (url.includes("/dependabot/alerts") && new URL(url).searchParams.has("page"))
				return Response.json({ message: "Numeric pagination is unsupported" }, { status: 400 });
			const q = String(init?.body);
			if (q.includes("query ActivityRefs"))
				return Response.json({
					data: {
						repository: {
							refs: { nodes: [], pageInfo: { hasNextPage: false } },
							tags: { nodes: [], pageInfo: { hasNextPage: false } },
						},
					},
				});
			if (q.includes("affiliations:[OWNER, COLLABORATOR"))
				return Response.json({
					data: {
						viewer: { repositories: { nodes: [rawRepo], pageInfo: { hasNextPage: false } } },
					},
				});
			if (q.includes("search(query"))
				return Response.json({
					data: { search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } } },
				});
			if (q.includes("vulnerabilityAlerts"))
				return Response.json({
					data: {
						repository: { vulnerabilityAlerts: { nodes: [], pageInfo: { hasNextPage: false } } },
					},
				});
			if (q.includes("contributionsCollection")) return Response.json({ data: { user: null } });
			if (q.includes("nameWithOwner")) return Response.json({ data: { repository: rawRepo } });
			if (q.includes("object(expression")) return Response.json({ data: { repository: {} } });
			return Response.json(
				url.includes("actions/runs") ? { total_count: 0, workflow_runs: [] } : [],
			);
		}),
	),
);
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
it("batches metadata and streams under one lease and one invocation", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	await executeRunPage(env, "r1", () => now);
	const run = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	expect(run?.invocations).toBe(1);
	expect(run?.steps.filter((step) => step.status === "success").length).toBeGreaterThan(2);
	expect(run?.requests).toBeGreaterThan(2);
});

it("collects stream pages in one invocation without increasing attempts", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			if (url.includes("/commits?"))
				return Response.json([], {
					headers: url.includes("page=2")
						? {}
						: { link: '<https://api.github.com/repos/nocoo/app/commits?page=2>; rel="next"' },
				});
			return base(url, init);
		}),
	);
	await executeRunPage(env, "r1", () => now);
	const run = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	expect(run?.steps.find((step) => step.kind === "commits")).toMatchObject({
		status: "success",
		attempts: 1,
		pages: 2,
	});
});

it("stops before another step after the wall budget without dropping the finished step", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	let time = now;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			time = new Date(Date.parse(now) + 25_000).toISOString();
			return base(url, init);
		}),
	);
	expect(await executeRunPage(env, "r1", () => time)).toBe(time);
	const run = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	expect(run?.cursor).toBe(1);
	expect(run?.steps[0]).toMatchObject({
		status: "success",
		attempts: 1,
		pages: 1,
		durationMs: 25_000,
	});
	expect(run?.steps[1]).toMatchObject({ status: "pending", attempts: 0 });
	expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
	{ pageCount: 3, requestMs: 10_000 },
	{ pageCount: 6, requestMs: 13_000 },
])(
	"resumes $pageCount stream pages across wall budgets without reclaiming live leases",
	async ({ pageCount, requestMs }) => {
		const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
		const base = vi.mocked(fetch).getMockImplementation();
		if (!base) throw new Error("fixture");
		let elapsed = 0;
		let pages = 0;
		const competingClaims: unknown[] = [];
		const time = () => new Date(Date.parse(now) + elapsed).toISOString();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				elapsed += requestMs;
				competingClaims.push(await claimRun(createDb(env.DB), "r1", time()));
				if (url.includes("/commits?")) {
					pages++;
					return Response.json([], {
						headers:
							pages === pageCount
								? {}
								: {
										link: `<https://api.github.com/repos/nocoo/app/commits?page=${pages + 1}>; rel="next"`,
									},
					});
				}
				return base(url, init);
			}),
		);
		expect(await executeRunPage(env, "r1", time)).toBe(time());
		expect(pages).toBe(1);
		const pending = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
		expect(pending?.steps[1]).toMatchObject({ pages: 1, error: null, attempts: 1 });
		while (pages < pageCount) await executeRunPage(env, "r1", time);
		const run = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
		expect(pages).toBe(pageCount);
		expect(run?.steps[0]).toMatchObject({ kind: "metadata", status: "success" });
		expect(run?.steps[1]).toMatchObject({
			kind: "commits",
			status: "success",
			attempts: 1,
			pages: pageCount,
			durationMs: requestMs * pageCount,
		});
		expect(run?.invocations).toBeGreaterThan(1);
		expect(competingClaims.every((claim) => claim === null)).toBe(true);
	},
);

it("checkpoints a long site step across bounded invocations without duplicate pages", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const db = createDb(env.DB);
	const found = await getRun(db, snap.account_id, "r1");
	if (!found) throw new Error("fixture");
	found.run.steps = found.run.steps.filter((step) => step.resource === "repo:nocoo/app:actions");
	await db
		.prepare("UPDATE factory_runs SET payload=? WHERE id='r1'")
		.bind(JSON.stringify(found.run))
		.run();
	let elapsed = 0;
	let pages = 0;
	const time = () => new Date(Date.parse(now) + elapsed).toISOString();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			pages++;
			elapsed += 13_000;
			expect(await claimRun(createDb(env.DB), "r1", time())).toBeNull();
			return Response.json(
				{ workflow_runs: [] },
				{
					headers:
						pages === 8
							? {}
							: {
									link: `<https://api.github.com/repos/nocoo/app/actions/runs?page=${pages + 1}>; rel="next"`,
								},
				},
			);
		}),
	);
	for (let attempt = 0; pages < 8 && attempt < 8; attempt++) await executeRunPage(env, "r1", time);
	const saved = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	expect(pages).toBe(8);
	expect(saved?.steps[0]).toMatchObject({
		status: "success",
		pages: 8,
		attempts: 1,
		durationMs: 104_000,
	});
	expect(saved?.invocations).toBeGreaterThan(1);
});

it("preserves a completed step after a mid-loop lease loss", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	let calls = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			if (++calls === 2) await controlRun(createDb(env.DB), snap.account_id, "r1", "pause", now);
			return base(url, init);
		}),
	);
	expect(await executeRunPage(env, "r1", () => now)).toBeNull();
	const db = createDb(env.DB);
	const resources = await db
		.prepare("SELECT stream,payload FROM factory_resources WHERE run_id='r1'")
		.all<{ stream: string; payload: string }>();
	expect(resources.results.map((resource) => resource.stream)).toEqual(["executor:checkpoint"]);
	expect(JSON.parse(resources.results[0]?.payload ?? "null")).toMatchObject({
		runId: "r1",
		repos: [{ name: "nocoo/app" }],
	});
	expect((await getRun(db, snap.account_id, "r1"))?.run).toMatchObject({
		status: "paused",
		cursor: 1,
		requests: 1,
	});
	expect(calls).toBe(2);
});

it.each(["pause", "cancel"] as const)(
	"keeps the attempted repo cooldown on %s after advancing past the durable cursor",
	async (action) => {
		const env = await setup();
		const db = createDb(env.DB);
		const found = await getRun(db, snap.account_id, "r1");
		if (!found) throw new Error("fixture");
		found.run.steps = found.run.steps.filter((step) =>
			["contributions", "metadata", "commits"].includes(step.kind),
		);
		await db
			.prepare("UPDATE factory_runs SET payload=? WHERE id='r1'")
			.bind(JSON.stringify(found.run))
			.run();
		let during: typeof found.run | undefined;
		const base = vi.mocked(fetch).getMockImplementation();
		if (!base) throw new Error("fixture");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (String(init.body).includes("nameWithOwner")) {
					during = (await getRun(db, snap.account_id, "r1"))?.run;
					await controlRun(db, snap.account_id, "r1", action, now);
				}
				return base(url, init);
			}),
		);
		expect(await executeRunPage(env, "r1", () => now)).toBeNull();
		expect(during?.cursor).toBe(1);
		expect(during?.steps[0]?.kind).toBe("contributions");
		expect(during?.steps[1]).toMatchObject({
			kind: "metadata",
			repo: "nocoo/app",
			attempts: 1,
		});
		expect(await repoStates(db, snap.account_id)).toEqual([
			expect.objectContaining({
				repo: "nocoo/app",
				attemptRunId: "r1",
				attemptStatus: action,
				attemptedAt: now,
				nextAllowedAt: "2026-09-15T22:15:00.000Z",
			}),
		]);
		expect((await getRun(db, snap.account_id, "r1"))?.run).toMatchObject({
			status: action === "pause" ? "paused" : "cancelled",
			cursor: 1,
			requests: 1,
		});
		expect(
			(await db.prepare("SELECT * FROM factory_resources WHERE run_id='r1'").all()).results,
		).toEqual([]);
		expect(fetch).toHaveBeenCalledTimes(2);
	},
);

it("recovers journalled attempts after a batch crashes before saving", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const db = createDb(env.DB);
	await db
		.prepare(
			"CREATE TEMP TRIGGER crash_batch BEFORE UPDATE OF payload ON factory_runs BEGIN SELECT RAISE(ABORT,'fixture crash'); END",
		)
		.run();
	await expect(executeRunPage(env, "r1", () => now)).rejects.toMatchObject({ code: "db_error" });
	expect(
		(await db.prepare("SELECT * FROM factory_resources WHERE run_id='r1'").all()).results,
	).toEqual([]);
	const attempted = (await getRun(db, snap.account_id, "r1"))?.run;
	expect(attempted?.steps[0]).toMatchObject({ status: "running", attempts: 1 });
	expect(attempted?.requests).toBe(vi.mocked(fetch).mock.calls.length);
	await db.prepare("DROP TRIGGER crash_batch").run();
	const later = new Date(Date.parse(now) + RUN_LEASE_MS + 1).toISOString();
	await executeRunPage(env, "r1", () => later);
	const recovered = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	expect(recovered?.steps[0]).toMatchObject({
		status: "success",
		attempts: 2,
		retryFailures: 0,
		pages: 1,
	});
	expect(recovered?.invocations).toBe(2);
});

it("keeps every earlier checkpoint when the third step save dies and retries promptly", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const db = createDb(env.DB);
	const logged = vi.spyOn(console, "log").mockImplementation(() => {});
	await db
		.prepare(
			"CREATE TEMP TRIGGER crash_third BEFORE UPDATE OF payload ON factory_runs WHEN json_extract(NEW.payload,'$.cursor')>=3 BEGIN SELECT RAISE(ABORT,'fixture third save'); END",
		)
		.run();
	await expect(executeRunPage(env, "r1", () => now)).rejects.toMatchObject({ code: "db_error" });
	const interrupted = await getRun(createDb(env.DB), snap.account_id, "r1");
	expect(interrupted?.leaseUntil).toBeNull();
	expect(interrupted?.run.cursor).toBe(2);
	expect(interrupted?.run.steps.slice(0, 2).map((step) => step.status)).toEqual([
		"success",
		"success",
	]);
	expect(interrupted?.run.steps[2]).toMatchObject({ status: "running", attempts: 1 });
	const entries = logged.mock.calls.map(([line]) => JSON.parse(String(line)));
	expect(entries.filter((entry) => entry.event === "factory_invocation")).toEqual([
		expect.objectContaining({
			runId: "r1",
			cursorStart: 0,
			endReason: "save_failed",
			operation: "save",
			requests: 3,
			error: { name: "ApiError", code: "db_error", message: "d1 operation failed" },
		}),
	]);
	await db.prepare("DROP TRIGGER crash_third").run();
	const next = new Date(Date.parse(now) + 5000).toISOString();
	await executeRunPage(env, "r1", () => next);
	const recovered = await getRun(createDb(env.DB), snap.account_id, "r1");
	expect(recovered?.run.steps.slice(0, 2).map((step) => step.attempts)).toEqual([1, 1]);
	expect(recovered?.run.steps[2]).toMatchObject({
		status: "success",
		attempts: 2,
		retryFailures: 0,
		error: null,
	});
	logged.mockRestore();
});

it("redispatches a competing claim at the live lease deadline without executing work", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const lease = await claimRun(createDb(env.DB), "r1", now);
	if (!lease) throw new Error("fixture");
	expect(await executeRunPage(env, "r1", () => now)).toBe(lease.leaseUntil);
	expect(fetch).not.toHaveBeenCalled();
	await executeRunPage(env, "r1", () => lease.leaseUntil);
	expect(fetch).toHaveBeenCalled();
});

it("saves earlier work but backs off at least fifteen minutes on a mid-loop rate limit", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	vi.useFakeTimers();
	vi.setSystemTime(now);
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) =>
			url.includes("/issues?") ? Response.json({}, { status: 429 }) : base(url, init),
		),
	);
	const next = await executeRunPage(env, "r1", () => now);
	expect(next).toBe(new Date(Date.parse(now) + 900_000).toISOString());
	const run = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	expect(run?.steps.find((step) => step.kind === "commits")).toMatchObject({
		status: "success",
		attempts: 1,
	});
	expect(run?.steps.find((step) => step.kind === "issues")).toMatchObject({
		status: "pending",
		error: "github_rate_limited",
	});
	expect(run?.steps.find((step) => step.kind === "issues")?.retryFailures ?? 0).toBe(0);
	expect(run?.steps.find((step) => step.kind === "prs")).toMatchObject({
		status: "pending",
		attempts: 0,
	});
	expect(run?.invocations).toBe(1);
});

it("yields at the shared budgets and resumes an unfinished site step without refetching", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const db = createDb(env.DB);
	const found = await getRun(db, snap.account_id, "r1");
	if (!found) throw new Error("fixture");
	found.run.steps = ["actions", "contributors"].flatMap((resource) =>
		found.run.steps.filter((step) => step.resource === `repo:nocoo/app:${resource}`),
	);
	await db
		.prepare("UPDATE factory_runs SET payload=? WHERE id='r1'")
		.bind(JSON.stringify(found.run))
		.run();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			const target = new URL(url);
			const page = Number(target.searchParams.get("page") ?? 1);
			const actions = target.pathname.endsWith("actions/runs");
			return Response.json(actions ? { workflow_runs: [] } : [], {
				headers:
					page === (actions ? 20 : 30)
						? {}
						: { link: `<https://api.github.com${target.pathname}?page=${page + 1}>; rel="next"` },
			});
		}),
	);
	await executeRunPage(env, "r1", () => now);
	const pending = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	const requested = vi.mocked(fetch).mock.calls.length;
	expect(requested).toBeGreaterThan(20);
	expect(requested).toBeLessThanOrEqual(40);
	expect(pending?.requests).toBe(requested);
	expect(pending?.steps[0]).toMatchObject({ status: "success", pages: 20 });
	expect(pending?.steps[1]).toMatchObject({
		status: "running",
		attempts: 1,
		pages: requested - 20,
		error: null,
	});
	await executeRunPage(env, "r1", () => now);
	const saved = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	expect(saved?.steps[1]).toMatchObject({
		status: "success",
		attempts: 1,
		pages: 30,
		retryFailures: 0,
	});
	expect(saved?.requests).toBe(50);
	expect(saved?.invocations).toBe(2);
});

it("uses fewer than half as many invocations as the selected-repository step plan", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const run = await drive(env);
	expect(run?.status).toBe("completed");
	expect(run?.steps).toHaveLength(19);
	expect(run?.invocations).toBeLessThan(10);
});

it("continues from drained repository work to publication within the same invocation", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	expect(await executeRunPage(env, "r1", () => now)).toBeNull();
	const run = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	expect(run?.status).toBe("completed");
	expect(run?.invocations).toBe(1);
	expect(run?.steps.every((step) => step.status === "success")).toBe(true);
	expect(run?.steps.at(-1)).toMatchObject({ kind: "publish", status: "success" });
	expect(run?.requests).toBeLessThanOrEqual(40);
	expect((await publishedFactory(createDb(env.DB), snap.account_id))?.runId).toBe("r1");
});

it("batches a 60-repository daily plan without changing its 1146 logical steps", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] }, true);
	const repos = Array.from({ length: 60 }, (_, index) => ({
		...structuredClone(snap.repos[0]),
		id: `R_${index}`,
		name: `nocoo/app-${index}`,
	})) as typeof snap.repos;
	const db = createDb(env.DB);
	const original = (await getRun(db, snap.account_id, "r1"))?.run;
	if (!original) throw new Error("fixture");
	const run = {
		...makeRun(
			"r1",
			snap.account_id,
			"nocoo",
			"k1",
			"refresh",
			repos,
			now,
			[],
			repos.map((repo) => repo.name),
			{ scope: "selected" },
			"quick",
			true,
		),
		trigger: "daily",
		activityWindow: original.activityWindow,
	};
	await db
		.prepare("UPDATE factory_runs SET payload=? WHERE id='r1'")
		.bind(JSON.stringify(run))
		.run();
	await db.batch(
		await replaceSnapshotStmts(db, snap.account_id, "factory", { ...snap, repos }, now),
	);
	await db.batch(
		await replaceSnapshotStmts(
			db,
			snap.account_id,
			"repos",
			{ repos: repos.map((repo) => ({ name_with_owner: repo.name })) },
			now,
		),
	);
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			const query = String(init?.body ?? "");
			if (query.includes("day0:"))
				return Response.json({
					data: {
						user: Object.fromEntries(
							Array.from({ length: 15 }, (_, index) => [
								`day${index}`,
								{
									totalCommitContributions: 0,
									totalIssueContributions: 0,
									totalPullRequestContributions: 0,
									totalPullRequestReviewContributions: 0,
									totalRepositoryContributions: 0,
									restrictedContributionsCount: 0,
								},
							]),
						),
					},
				});
			if (query.includes("contributionsCollection"))
				return Response.json({
					data: {
						user: {
							contributionsCollection: {
								restrictedContributionsCount: 0,
								contributionCalendar: {
									totalContributions: 0,
									weeks: [
										{
											contributionDays: contributionDates(
												run.window.since.slice(0, 10),
												run.window.until.slice(0, 10),
											).map((date) => ({
												date,
												contributionCount: 0,
											})),
										},
									],
								},
							},
						},
					},
				});
			if (query.includes("affiliations:[OWNER, COLLABORATOR"))
				return Response.json({
					data: {
						viewer: {
							repositories: {
								nodes: repos.map((repo) => ({ ...rawRepo, id: repo.id, nameWithOwner: repo.name })),
								pageInfo: { hasNextPage: false },
							},
						},
					},
				});
			if (query.includes("openPrs:")) {
				const name = String(JSON.parse(query).variables.name);
				const repo = repos.find((repo) => repo.name === `nocoo/${name}`);
				if (!repo) throw new Error("unexpected repository");
				return Response.json({
					data: { repository: { ...rawRepo, id: repo.id, nameWithOwner: repo.name } },
				});
			}
			return base(url, init);
		}),
	);
	for (let invocation = 0; invocation < 600; invocation++) {
		const saved = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
		if (!saved) throw new Error("fixture");
		if (saved.status !== "running") {
			expect(saved.steps).toHaveLength(1146);
			expect(
				saved.status,
				JSON.stringify(saved.steps.filter((step) => step.status === "failed")),
			).toBe("completed");
			expect(saved.invocations).toBeLessThan(320);
			expect(saved.requests).toBeLessThan(1270);
			expect(saved.publishedAt).toBe(now);
			return;
		}
		await executeRunPage(env, "r1", () => saved.nextAttemptAt);
	}
	throw new Error("daily simulation did not finish");
}, 30_000);

it("retains completed durations on crash replay and never counts uncommitted stream pages", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const db = createDb(env.DB);
	const found = await getRun(db, snap.account_id, "r1");
	if (!found) throw new Error("fixture");
	found.run.steps = found.run.steps.filter((step) => ["metadata", "commits"].includes(step.kind));
	await db
		.prepare("UPDATE factory_runs SET payload=? WHERE id='r1'")
		.bind(JSON.stringify(found.run))
		.run();
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	let elapsed = 0;
	const time = () => new Date(Date.parse(now) + elapsed).toISOString();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			elapsed += 1000;
			if (url.includes("/commits?"))
				return Response.json([], {
					headers: url.includes("page=2")
						? {}
						: { link: '<https://api.github.com/repos/nocoo/app/commits?page=2>; rel="next"' },
				});
			return base(url, init);
		}),
	);
	await db
		.prepare(
			"CREATE TEMP TRIGGER crash_batch BEFORE UPDATE OF payload ON factory_runs WHEN json_extract(NEW.payload,'$.cursor')>=2 BEGIN SELECT RAISE(ABORT,'fixture crash'); END",
		)
		.run();
	await expect(executeRunPage(env, "r1", time)).rejects.toMatchObject({ code: "db_error" });
	const interrupted = (await getRun(db, snap.account_id, "r1"))?.run;
	expect(interrupted?.steps[0]?.durationMs).toBe(1000);
	expect(interrupted?.steps[1]).toMatchObject({ durationMs: 2000, pages: 1 });
	expect(interrupted?.requests).toBe(3);
	expect((await getRun(createDb(env.DB), snap.account_id, "r1"))?.leaseUntil).toBeNull();
	await db.prepare("DROP TRIGGER crash_batch").run();
	elapsed += 5000;
	await executeRunPage(env, "r1", time);
	const recovered = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	expect(recovered?.steps[0]).toMatchObject({ durationMs: 1000, attempts: 1, pages: 1 });
	expect(recovered?.steps[1]).toMatchObject({ durationMs: 3000, attempts: 2, pages: 2 });
	expect(recovered?.requests).toBe(4);
});

it("bounds repeated crashed attempts even when each unsaved attempt otherwise succeeds", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const db = createDb(env.DB);
	const found = await getRun(db, snap.account_id, "r1");
	if (!found) throw new Error("fixture");
	found.run.steps = found.run.steps.filter((step) => step.kind === "metadata");
	await db
		.prepare("UPDATE factory_runs SET payload=? WHERE id='r1'")
		.bind(JSON.stringify(found.run))
		.run();
	await db
		.prepare(
			"CREATE TEMP TRIGGER crash_batch BEFORE UPDATE OF payload ON factory_runs BEGIN SELECT RAISE(ABORT,'fixture crash'); END",
		)
		.run();
	let elapsed = 0;
	const time = () => new Date(Date.parse(now) + elapsed).toISOString();
	for (let attempt = 0; attempt < 4; attempt++) {
		await expect(executeRunPage(env, "r1", time)).rejects.toMatchObject({ code: "db_error" });
		elapsed += RUN_LEASE_MS + 1;
	}
	await db.prepare("DROP TRIGGER crash_batch").run();
	await executeRunPage(env, "r1", time);
	expect(fetch).toHaveBeenCalledTimes(4);
	const saved = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	expect(saved?.steps[0]).toMatchObject({
		status: "failed",
		error: "worker_interrupted",
		retryFailures: 4,
	});
	expect(saved?.status).toBe("partial");
});
it("finishes expected unavailable streams without a partial publication", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) =>
			String(init?.body).includes("vulnerabilityAlerts")
				? Response.json({
						data: { repository: null },
						errors: [
							{
								type: "FORBIDDEN",
								message: "Dependabot alerts are disabled for this repository.",
								path: ["repository"],
							},
						],
					})
				: url.includes("/dependabot/alerts")
					? Response.json(
							{ message: "Dependabot alerts are disabled for this repository." },
							{ status: 403 },
						)
					: base(url, init),
		),
	);
	const run = await drive(env);
	expect(run?.steps.find((step) => step.kind === "alerts")).toMatchObject({
		status: "unavailable",
		error: "alerts_disabled",
	});
	expect(run?.steps.find((step) => step.resource === "repo:nocoo/app:security")).toMatchObject({
		status: "unavailable",
		error: "alerts_disabled",
	});
	expect(
		await readSnapshot(createDb(env.DB), snap.account_id, "repo:nocoo/app:security"),
	).toMatchObject({
		unavailable: false,
		truncated: false,
		dependabot_open: null,
		code_scanning_open: 0,
		features: {
			dependabot: { status: "unavailable", reason_code: "alerts_disabled" },
			code_scanning: { status: "available" },
		},
	});
	expect(run?.status).toBe("completed");
	expect((await publishedFactory(createDb(env.DB), snap.account_id))?.status).toBe("complete");
});

it.each([false, true])(
	"keeps dependency safe-parse limits separate from genuine failures (%s)",
	async (failure) => {
		const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
		const base = vi.mocked(fetch).getMockImplementation();
		if (!base) throw new Error("fixture");
		let parsed = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (String(init?.body).includes("object(expression")) {
					parsed = true;
					return Response.json({ data: { repository: { ci: { text: "jobs: *unsupported" } } } });
				}
				return failure && parsed && url.includes("/releases")
					? Response.json({ invalid: true })
					: base(url, init);
			}),
		);
		const run = await drive(env);
		expect(run?.steps.find((step) => step.kind === "dependencies")).toMatchObject({
			status: "limited",
			error: "dependency_parse_unsupported",
		});
		expect(run?.status).toBe(failure ? "partial" : "completed");
		const db = createDb(env.DB);
		expect((await publishedFactory(db, snap.account_id))?.status).toBe(
			failure ? "partial" : "complete",
		);
		expect((await listRuns(db, snap.account_id))[0]?.counts).toMatchObject({
			limited: 1,
			failed: failure ? 1 : 0,
		});
	},
);

it("uses current metadata for activity after a retained repository changes default branch", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] }, true);
	const db = createDb(env.DB);
	const lease = await claimRun(db, "r1", now);
	const previous = structuredClone(snap.repos[0]);
	if (!lease || !previous) throw new Error("Missing repository fixture");
	previous.observation = {
		version: "previous",
		window: snap.window,
		refreshedAt: now,
		source: "run",
	};
	previous.coverage.dependencies = {
		...previous.coverage.dependencies,
		status: "limited",
		reason_code: "dependency_parse_unsupported",
	};
	expect(
		await saveRun(
			db,
			lease,
			await repositoryWrites(db, lease, now, previous, previous.name, null, true),
			now,
		),
	).toBe(true);
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("Missing GitHub fixture");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			const query = String(init?.body);
			if (query.includes("repository(owner:$owner,name:$name){id nameWithOwner"))
				return Response.json({
					data: {
						repository: {
							...rawRepo,
							defaultBranchRef: { ...rawRepo.defaultBranchRef, name: "trunk" },
						},
					},
				});
			if (query.includes("query ActivityRefs"))
				return Response.json({
					data: {
						repository: {
							refs: {
								nodes: ["main", "trunk"].map((name) => ({
									name,
									target: {
										oid: name,
										history: {
											nodes: [{ oid: name, committedDate: now, message: name }],
											pageInfo: { hasNextPage: false },
										},
									},
								})),
								pageInfo: { hasNextPage: false },
							},
							tags: { nodes: [], pageInfo: { hasNextPage: false } },
						},
					},
				});
			if (query.includes("object(expression"))
				return Response.json({ data: { repository: { ci: { text: "jobs: *unsupported" } } } });
			if (url.includes("actions/runs") && !url.includes("status=success"))
				return Response.json({
					total_count: 1,
					workflow_runs: [
						{
							id: 1,
							workflow_id: 1,
							created_at: now,
							head_branch: "trunk",
							head_sha: "abc",
							event: "push",
							status: "completed",
							conclusion: "failure",
							actor: { login: "nocoo" },
							run_attempt: 1,
						},
					],
				});
			return base(url, init);
		}),
	);
	const run = await drive(env);
	expect(run?.steps.filter((step) => step.status === "failed")).toMatchObject([
		{ kind: "contributions", error: "snapshot_incomplete" },
	]);
	expect(run?.status).toBe("partial");
	expect(run?.steps.find((step) => step.kind === "commit")?.status).toBe("success");
	expect(run?.steps.find((step) => step.kind === "activity")?.status).toBe("success");
	expect(run?.steps.find((step) => step.kind === "metadata")).toMatchObject({
		status: "success",
		sourceBranch: "trunk",
	});
	expect(await currentRepo(db, snap.account_id, previous.name)).toMatchObject({
		branch: "trunk",
		observation: { version: "r1" },
		coverage: {
			dependencies: { retained: true, fetchedAt: previous.coverage.dependencies.fetchedAt },
		},
	});
	const activity = await readActivity(db, snap.account_id, {});
	expect(activity.repos[0]).toMatchObject({
		ci_runs: [{ id: 1, is_default_branch: true }],
		commits: {
			default: 1,
			other: 1,
			items: [
				{ sha: "abc", branch: "trunk", is_default_branch: true },
				{ sha: "main", branch: "main", is_default_branch: false },
			],
		},
		coverage: { default_branch: { status: "complete" } },
	});
	expect(activity.totals.red_default_branch).toMatchObject([{ id: 1 }]);
});

it("keeps other-branch commits unknown when resuming metadata from before sourceBranch existed", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] }, true);
	const db = createDb(env.DB);
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("Missing GitHub fixture");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			const query = String(init?.body);
			if (query.includes("query ActivityRefs") || query.includes("query ActivityTags"))
				return Response.json({
					data: {
						repository: {
							refs: {
								nodes: ["main", "feature"].map((name) => ({
									name,
									target: {
										oid: name,
										history: {
											nodes: [{ oid: name, committedDate: now, message: name }],
											pageInfo: { hasNextPage: false },
										},
									},
								})),
								pageInfo: { hasNextPage: false },
							},
							tags: {
								nodes: [
									{ name: "v1", target: { __typename: "Tag", oid: "tag", tagger: { date: now } } },
								],
								pageInfo: { hasNextPage: false },
							},
						},
					},
				});
			return base(url, init);
		}),
	);
	await beforeMetadata(env);
	await executeMetadata(env);
	const lease = await claimRun(db, "r1", now);
	const metadata = lease?.run.steps.find((step) => step.kind === "metadata");
	if (!lease || !metadata) throw new Error("Missing completed metadata fixture");
	expect(metadata.status).toBe("success");
	delete metadata.sourceBranch;
	expect(await saveRun(db, lease, [], now)).toBe(true);
	const run = await drive(env);
	expect(run?.steps.find((step) => step.kind === "metadata")).not.toHaveProperty("sourceBranch");
	expect(run?.steps.find((step) => step.kind === "activity")?.status).toBe("success");
	expect(await currentRepo(db, snap.account_id, "nocoo/app")).toMatchObject({ branch: "main" });
	const activity = await readActivity(db, snap.account_id, {});
	expect(activity.repos[0]).toMatchObject({
		commits: { other: null },
		releases: [{ id: "tag:tag", state: "tag" }],
		coverage: {
			other_commits: { status: "unavailable", truncated: false },
			tags: { status: "complete" },
			deploy: { status: "complete" },
		},
	});
	expect(activity.repos[0]?.commits.items?.filter((commit) => !commit.is_default_branch)).toEqual(
		[],
	);
	expect(
		vi
			.mocked(fetch)
			.mock.calls.some(([, init]) => String(init?.body).includes("query ActivityRefs")),
	).toBe(false);
});

it("B2 withholds hollow activity publication when no frozen snapshots despite a failed repository step", async () => {
	const env = await setup("refresh", { scope: "all" }, true);
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) =>
			url.includes("/releases") ? Response.json({ invalid: true }) : base(url, init),
		),
	);
	const run = await drive(env);
	expect(run?.status).toBe("partial");
	expect(run?.steps.find((step) => step.kind === "releases")?.status).toBe("failed");
	expect(run?.steps.find((step) => step.kind === "publish")?.status).toBe("success");
	expect(
		(
			await createDb(env.DB)
				.prepare(
					"SELECT COUNT(*) AS n FROM factory_resources WHERE run_id='r1' AND stream='activity-snapshot'",
				)
				.first<{ n: number }>()
		)?.n,
	).toBe(0);
	expect(
		(
			await createDb(env.DB)
				.prepare("SELECT COUNT(*) AS n FROM activity_publications WHERE run_id='r1'")
				.first<{ n: number }>()
		)?.n,
	).toBe(0);
	await expect(readActivity(createDb(env.DB), snap.account_id, {})).rejects.toMatchObject({
		status: 409,
		code: "activity_unpublished",
	});
	expect(await publishedFactory(createDb(env.DB), snap.account_id)).toMatchObject({ runId: "r1" });
});

it.each([
	{ status: 403, message: "Resource not accessible by integration", code: "permission_denied" },
	{ status: 404, message: "Not Found", code: "not_found" },
	{ status: 403, message: "Forbidden", code: "coverage_limited" },
	{ status: 403, message: "Dependabot alerts are disabled", code: "alerts_disabled" },
])("B2 keeps mid-pagination access loss failed: $message", async ({ status, message, code }) => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	let pages = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			if (!url.includes("/dependabot/alerts")) return base(url, init);
			pages++;
			return new URL(url).searchParams.has("after")
				? Response.json({ message }, { status })
				: Response.json([], {
						headers: {
							Link: '<https://api.github.com/repos/nocoo/app/dependabot/alerts?after=next>; rel="next"',
						},
					});
		}),
	);
	const run = await drive(env);
	expect(pages).toBe(2);
	expect(run?.steps.find((step) => step.kind === "alerts")).toMatchObject({
		status: "failed",
		error: code,
	});
	expect(run?.status).toBe("partial");
	expect((await listRuns(createDb(env.DB), snap.account_id))[0]?.counts).toMatchObject({
		failed: 1,
		limited: 0,
	});
	expect((await publishedFactory(createDb(env.DB), snap.account_id))?.status).toBe("partial");
});

it("B2 counts dependency capacity truncation as limited rather than failed", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	const text = JSON.stringify({
		dependencies: Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`dep-${i}`, "1"])),
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) =>
			String(init?.body).includes("object(expression")
				? Response.json({ data: { repository: { package: { text } } } })
				: base(url, init),
		),
	);
	const run = await drive(env);
	expect(run?.steps.find((step) => step.kind === "dependencies")).toMatchObject({
		status: "limited",
		error: "coverage_limited",
	});
	expect(run?.status).toBe("completed");
	expect((await listRuns(createDb(env.DB), snap.account_id))[0]?.counts).toMatchObject({
		limited: 1,
		failed: 0,
	});
});

it.each([
	["issues", "graphql"],
	["issues", "http"],
	["prs", "graphql"],
	["prs", "http"],
])(
	"keeps first-page %s %s denial unavailable throughout the full plan",
	async (resource, transport) => {
		const env = await setup();
		const db = createDb(env.DB);
		const old = {
			truncated: false,
			fetched_at: "2025-01-01T00:00:00.000Z",
			[resource === "prs" ? "pull_requests" : "issues"]: [],
		};
		const insights = { truncated: false, fetched_at: old.fetched_at, insights: [] };
		await db.batch(await replaceSnapshotStmts(db, snap.account_id, resource, old, old.fetched_at));
		await db.batch(
			await replaceSnapshotStmts(db, snap.account_id, "insights", insights, insights.fetched_at),
		);
		const base = vi.mocked(fetch).getMockImplementation();
		if (!base) throw new Error("fixture");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) =>
				String(init?.body).includes("contributionsCollection")
					? Response.json({ data: { user: null }, errors: [{ type: "FORBIDDEN", path: ["user"] }] })
					: String(init?.body).includes(`is:${resource === "prs" ? "pr" : "issue"}`)
						? transport === "http"
							? Response.json(
									{ message: "Resource not accessible by integration" },
									{ status: 403 },
								)
							: Response.json({
									data: { search: null },
									errors: [{ type: "FORBIDDEN", path: ["search"] }],
								})
						: base(url, init),
			),
		);
		const run = await drive(env);
		expect(run?.steps.find((step) => step.resource === resource)).toMatchObject({
			status: "unavailable",
			error: "github_forbidden",
		});
		expect(run?.status).toBe("completed");
		expect(await publishedFactory(db, snap.account_id)).toMatchObject({
			runId: "r1",
			status: "complete",
		});
		expect((await listRuns(db, snap.account_id))[0]?.counts.failed).toBe(0);
		expect(await readSnapshot(db, snap.account_id, resource)).toEqual(old);
		if (resource === "issues") {
			expect(run?.steps.find((step) => step.resource === "insights")).toMatchObject({
				status: "unavailable",
				error: "snapshot_unavailable",
			});
			expect(await readSnapshot(db, snap.account_id, "insights")).toEqual(insights);
		}
	},
);

it.each([1, 2])(
	"fails partial security GraphQL nodes without replacing retained evidence (%s nodes)",
	async (nodes) => {
		const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
		const db = createDb(env.DB);
		const kind = "repo:nocoo/app:security";
		const old = {
			truncated: false,
			unavailable: false,
			fetched_at: "2025-01-01T00:00:00.000Z",
			dependabot_open: 7,
			code_scanning_open: 0,
		};
		await db.batch(await replaceSnapshotStmts(db, snap.account_id, kind, old, old.fetched_at));
		const base = vi.mocked(fetch).getMockImplementation();
		if (!base) throw new Error("fixture");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) =>
				String(init?.body).includes("vulnerabilityAlerts")
					? Response.json({
							data: {
								repository: {
									vulnerabilityAlerts: {
										nodes: Array.from({ length: nodes }, (_, i) => ({ id: `alert-${i}` })),
										pageInfo: { hasNextPage: false },
									},
								},
							},
							errors: [
								{ type: "FORBIDDEN", path: ["repository", "vulnerabilityAlerts", "nodes", 0] },
							],
						})
					: base(url, init),
			),
		);
		const run = await drive(env);
		expect(run?.steps.find((step) => step.resource === kind)).toMatchObject({
			status: "failed",
			error: "snapshot_incomplete",
		});
		expect(run?.status).toBe("partial");
		expect(await publishedFactory(db, snap.account_id)).toMatchObject({
			runId: "r1",
			status: "partial",
		});
		expect((await listRuns(db, snap.account_id))[0]?.counts.failed).toBeGreaterThan(0);
		expect(await readSnapshot(db, snap.account_id, kind)).toEqual(old);
	},
);

it("publishes partial when a real page failure makes the run partial", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) =>
			url.includes("/traffic/")
				? Response.json({ message: "Upstream failed" }, { status: 500 })
				: base(url, init),
		),
	);
	const run = await drive(env);
	expect(run?.status).toBe("partial");
	expect((await publishedFactory(createDb(env.DB), snap.account_id))?.status).toBe("partial");
});

it.each([
	"repos",
	"issues",
	"prs",
	"actions",
	"releases",
	"contributors",
	"notifications",
	"security",
])("rejects invalid %s list elements instead of publishing successful zero", async (resource) => {
	const env = await setup(
		resource === "repos" ? "catalog" : "refresh",
		resource === "notifications" ? { scope: "all" } : { scope: "selected", repos: ["nocoo/app"] },
	);
	const db = createDb(env.DB);
	const kind = ["repos", "notifications"].includes(resource)
		? resource
		: `repo:nocoo/app:${resource}`;
	const old = {
		truncated: false,
		fetched_at: "2025-01-01T00:00:00.000Z",
		...(resource === "security"
			? { dependabot_open: 7, code_scanning_open: 2 }
			: {
					[resource === "actions" ? "runs" : resource === "prs" ? "pull_requests" : resource]: [
						{ name_with_owner: "nocoo/app", id: 9001, number: 9001, login: "retained" },
					],
				}),
	};
	await db.batch(await replaceSnapshotStmts(db, snap.account_id, kind, old, old.fetched_at));
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	let injected = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			const query = String(init?.body);
			if (query.includes("contributionsCollection"))
				return Response.json({
					data: { user: null },
					errors: [{ type: "FORBIDDEN", path: ["user"] }],
				});
			if (resource === "repos" && query.includes("ownerAffiliations"))
				return Response.json({
					data: {
						viewer: {
							login: "nocoo",
							repositories: { totalCount: 1, nodes: [rawRepo], pageInfo: { hasNextPage: false } },
						},
					},
				});
			if (resource === "repos" && query.includes("viewer")) {
				injected++;
				return Response.json({
					data: { viewer: { repositories: { nodes: [7], pageInfo: { hasNextPage: false } } } },
				});
			}
			if (
				["issues", "prs"].includes(resource) &&
				query.includes(`is:${resource === "prs" ? "pr" : "issue"}`)
			) {
				injected++;
				return Response.json({
					data: { search: { nodes: [7], issueCount: 1, pageInfo: { hasNextPage: false } } },
				});
			}
			const target = new URL(url);
			const suffix =
				resource === "actions"
					? "/actions/runs"
					: resource === "security"
						? "/code-scanning/alerts"
						: `/${resource}`;
			if (
				!["repos", "issues", "prs"].includes(resource) &&
				target.pathname.endsWith(suffix) &&
				!target.searchParams.has("created") &&
				!target.searchParams.has("page")
			) {
				injected++;
				return Response.json(
					resource === "actions" ? { total_count: 1, workflow_runs: [null] } : [null],
				);
			}
			return base(url, init);
		}),
	);
	const run = await drive(env);
	expect(injected).toBe(1);
	expect(run?.steps.find((step) => step.resource === kind)).toMatchObject({
		status: "failed",
		error: "snapshot_incomplete",
		attempts: 1,
	});
	expect(run?.status).toBe(resource === "repos" ? "failed" : "partial");
	expect(await publishedFactory(db, snap.account_id)).toMatchObject(
		resource === "repos" ? { runId: snap.runId } : { runId: "r1", status: "partial" },
	);
	expect((await listRuns(db, snap.account_id))[0]?.counts.failed).toBeGreaterThan(0);
	expect(await readSnapshot(db, snap.account_id, kind)).toEqual(old);
});

it.each(["issues", "prs"] as const)(
	"fails malformed %s search through the executor without replacing saved evidence",
	async (resource) => {
		const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
		const kind = `repo:nocoo/app:${resource}`;
		const old = { truncated: false, fetched_at: "2025-01-01T00:00:00.000Z", marker: "retained" };
		const db = createDb(env.DB);
		await db.batch(await replaceSnapshotStmts(db, snap.account_id, kind, old, old.fetched_at));
		const base = vi.mocked(fetch).getMockImplementation();
		if (!base) throw new Error("fixture");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) =>
				String(init?.body).includes(`is:${resource === "prs" ? "pr" : "issue"}`)
					? Response.json({ data: { search: {} } })
					: base(url, init),
			),
		);
		const run = await drive(env);
		expect(run?.steps.find((step) => step.resource === kind)).toMatchObject({
			status: "failed",
			error: "snapshot_incomplete",
			attempts: 1,
		});
		expect(run?.status).toBe("partial");
		expect(await publishedFactory(db, snap.account_id)).toMatchObject({
			runId: "r1",
			status: "partial",
		});
		expect((await listRuns(db, snap.account_id))[0]?.counts.failed).toBeGreaterThan(0);
		expect(await readSnapshot(db, snap.account_id, kind)).toEqual(old);
	},
);

it.each(["issues", "prs"])(
	"fails partial %s search even when every node is denied",
	async (resource) => {
		const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
		const db = createDb(env.DB);
		const kind = `repo:nocoo/app:${resource}`;
		const old = {
			truncated: false,
			fetched_at: "2025-01-01T00:00:00.000Z",
			[resource === "prs" ? "pull_requests" : "issues"]: [{ number: 9001 }],
		};
		await db.batch(await replaceSnapshotStmts(db, snap.account_id, kind, old, old.fetched_at));
		const base = vi.mocked(fetch).getMockImplementation();
		if (!base) throw new Error("fixture");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) =>
				String(init?.body).includes(`is:${resource === "prs" ? "pr" : "issue"}`)
					? Response.json({
							data: { search: { nodes: [null], issueCount: 1, pageInfo: { hasNextPage: false } } },
							errors: [{ type: "FORBIDDEN", path: ["search", "nodes", 0] }],
						})
					: base(url, init),
			),
		);
		const run = await drive(env);
		expect(run?.steps.find((step) => step.resource === kind)).toMatchObject({
			status: "failed",
			error: "snapshot_incomplete",
		});
		expect(run?.status).toBe("partial");
		expect(await publishedFactory(db, snap.account_id)).toMatchObject({
			runId: "r1",
			status: "partial",
		});
		expect((await listRuns(db, snap.account_id))[0]?.counts.failed).toBeGreaterThan(0);
		expect(await readSnapshot(db, snap.account_id, kind)).toEqual(old);
	},
);

it.each(["repos", "issues", "prs", "security"])(
	"fails %s GraphQL connections without an explicit pagination flag",
	async (resource) => {
		const env = await setup(resource === "repos" ? "catalog" : "refresh", {
			scope: "selected",
			repos: ["nocoo/app"],
		});
		const db = createDb(env.DB);
		const kind = resource === "repos" ? "repos" : `repo:nocoo/app:${resource}`;
		const old = {
			truncated: false,
			fetched_at: "2025-01-01T00:00:00.000Z",
			repos: [{ name_with_owner: "nocoo/app" }],
			issues: [],
			pull_requests: [],
			dependabot_open: 7,
			code_scanning_open: 2,
		};
		await db.batch(await replaceSnapshotStmts(db, snap.account_id, kind, old, old.fetched_at));
		const base = vi.mocked(fetch).getMockImplementation();
		if (!base) throw new Error("fixture");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				const query = String(init?.body);
				const connection = { nodes: [], issueCount: 0, pageInfo: {} };
				if (resource === "repos" && query.includes("ownerAffiliations"))
					return Response.json({
						data: {
							viewer: {
								login: "nocoo",
								repositories: { totalCount: 1, nodes: [rawRepo], pageInfo: { hasNextPage: false } },
							},
						},
					});
				if (resource === "repos" && query.includes("viewer"))
					return Response.json({ data: { viewer: { repositories: connection } } });
				if (resource === "security" && query.includes("vulnerabilityAlerts"))
					return Response.json({ data: { repository: { vulnerabilityAlerts: connection } } });
				if (
					["issues", "prs"].includes(resource) &&
					query.includes(`is:${resource === "prs" ? "pr" : "issue"}`)
				)
					return Response.json({ data: { search: connection } });
				return base(url, init);
			}),
		);
		const run = await drive(env);
		expect(run?.steps.find((step) => step.resource === kind)).toMatchObject({
			status: "failed",
			error: "snapshot_incomplete",
		});
		expect(run?.status).toBe(resource === "repos" ? "failed" : "partial");
		expect(await publishedFactory(db, snap.account_id)).toMatchObject(
			resource === "repos" ? { runId: snap.runId } : { runId: "r1", status: "partial" },
		);
		expect((await listRuns(db, snap.account_id))[0]?.counts.failed).toBeGreaterThan(0);
		expect(await readSnapshot(db, snap.account_id, kind)).toEqual(old);
	},
);

it.each([403, 404])(
	"fails interrupted Actions pagination (%s), even after an empty first page",
	async (status) => {
		const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
		const kind = "repo:nocoo/app:actions";
		const old = { truncated: false, fetched_at: "2025-01-01T00:00:00.000Z", runs: [{ id: 9001 }] };
		const db = createDb(env.DB);
		await db.batch(await replaceSnapshotStmts(db, snap.account_id, kind, old, old.fetched_at));
		const base = vi.mocked(fetch).getMockImplementation();
		if (!base) throw new Error("fixture");
		let pages = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (url.includes("/actions/runs") && !new URL(url).searchParams.has("created")) {
					pages++;
					return new URL(url).searchParams.get("page") === "2"
						? Response.json({ message: "Resource not accessible by integration" }, { status })
						: Response.json(
								{ workflow_runs: status === 403 ? [{ id: 1 }] : [] },
								{
									headers: {
										link: '<https://api.github.com/repos/nocoo/app/actions/runs?page=2>; rel="next"',
									},
								},
							);
				}
				return base(url, init);
			}),
		);
		const run = await drive(env);
		expect(pages).toBe(2);
		expect(run?.steps.find((step) => step.resource === kind)).toMatchObject({
			status: "failed",
			error: "snapshot_incomplete",
			attempts: 1,
		});
		expect(run?.status).toBe("partial");
		expect(await publishedFactory(db, snap.account_id)).toMatchObject({
			runId: "r1",
			status: "partial",
		});
		expect((await listRuns(db, snap.account_id))[0]?.counts.failed).toBeGreaterThan(0);
		expect(await readSnapshot(db, snap.account_id, kind)).toEqual(old);
	},
);

it.each(
	["actions", "releases", "contributors", "notifications"].flatMap((resource) =>
		["next link", "envelope"].map((invalid) => [resource, invalid]),
	),
)("fails %s with an invalid REST %s", async (resource, invalid) => {
	const env = await setup();
	const db = createDb(env.DB);
	const kind = resource === "notifications" ? resource : `repo:nocoo/app:${resource}`;
	const old = {
		truncated: false,
		fetched_at: "2025-01-01T00:00:00.000Z",
		[resource === "actions" ? "runs" : resource]: [{ id: 9001 }],
	};
	await db.batch(await replaceSnapshotStmts(db, snap.account_id, kind, old, old.fetched_at));
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	let calls = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			const target = new URL(url);
			if (
				target.pathname.endsWith(resource === "actions" ? "/actions/runs" : `/${resource}`) &&
				!target.searchParams.has("created") &&
				!target.searchParams.has("page")
			) {
				calls++;
				if (invalid === "envelope")
					return Response.json(resource === "actions" ? [] : { workflow_runs: [] });
				return Response.json(resource === "actions" ? { workflow_runs: [] } : [], {
					headers: { link: '<not-a-url>; rel="next"' },
				});
			}
			return base(url, init);
		}),
	);
	const run = await drive(env);
	expect(calls).toBe(1);
	expect(run?.steps.find((step) => step.resource === kind)).toMatchObject({
		status: "failed",
		error: "snapshot_incomplete",
	});
	expect(run?.status).toBe("partial");
	expect(await publishedFactory(db, snap.account_id)).toMatchObject({
		runId: "r1",
		status: "partial",
	});
	expect((await listRuns(db, snap.account_id))[0]?.counts.failed).toBeGreaterThan(0);
	expect(await readSnapshot(db, snap.account_id, kind)).toEqual(old);
});

it("keeps denied repository access separate from identity mismatches", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) =>
			String(init?.body).includes("nameWithOwner")
				? Response.json({
						data: { repository: null },
						errors: [{ type: "FORBIDDEN", path: ["repository"] }],
					})
				: base(url, init),
		),
	);
	const run = await drive(env);
	expect(run?.steps.find((step) => step.kind === "metadata")).toMatchObject({
		status: "unavailable",
	});
	expect(
		run?.steps
			.filter((step) => step.repo && step.kind !== "snapshot")
			.every((step) => step.status === "unavailable"),
	).toBe(true);
	expect(run?.status).toBe("completed");
});

it("separates denied contributions from malformed contribution evidence", async () => {
	const env = await setup();
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) =>
			String(init?.body).includes("contributionsCollection")
				? Response.json({
						data: { user: null },
						errors: [
							{
								type: "FORBIDDEN",
								path: ["user"],
								message: "Resource not accessible by integration",
							},
						],
					})
				: base(url, init),
		),
	);
	const run = await drive(env);
	expect(run?.steps.find((step) => step.kind === "contributions")).toMatchObject({
		status: "unavailable",
		error: "coverage_unavailable",
	});
	expect(run?.status).toBe("completed");
});
it("R4 eligible daily executor freezes supplemental activity and publishes a readable immutable window", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] }, true);
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			const query = String(init?.body);
			if (query.includes("day0:"))
				return Response.json({
					data: {
						user: Object.fromEntries(
							Array.from({ length: 15 }, (_, index) => [
								`day${index}`,
								{
									totalCommitContributions: 0,
									totalIssueContributions: 0,
									totalPullRequestContributions: 0,
									totalPullRequestReviewContributions: 0,
									totalRepositoryContributions: 0,
									restrictedContributionsCount: 0,
								},
							]),
						),
					},
				});
			if (query.includes("contributionsCollection"))
				return Response.json({
					data: {
						user: {
							contributionsCollection: {
								restrictedContributionsCount: 0,
								contributionCalendar: {
									totalContributions: 0,
									weeks: [
										{
											contributionDays: contributionDates(
												String(JSON.parse(String(init.body)).variables.since).slice(0, 10),
												String(JSON.parse(String(init.body)).variables.until).slice(0, 10),
											).map((date) => ({
												date,
												contributionCount: 0,
											})),
										},
									],
								},
							},
						},
					},
				});
			return base(url, init);
		}),
	);
	await executeRunPage(env, "r1", () => now);
	await executeRunPage(env, "r1", () => now);
	await executeRunPage(env, "r1", () => now);
	const pending = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	expect(pending?.publishedAt).toBeNull();
	expect(pending?.steps.find((step) => step.kind === "contributions")).toMatchObject({
		kind: "contributions",
		status: "success",
		pages: 3,
	});
	expect(pending?.checkpoint?.contributionStatus).toBe("complete");
	expect((await publishedFactory(createDb(env.DB), snap.account_id))?.runId).toBe(snap.runId);
	const run = await drive(env);
	expect(run?.status).toBe("completed");
	expect(run?.steps).toHaveLength(25);
	expect(run?.publishedAt).toBe(now);
	const sources = await readSources(createDb(env.DB), snap.account_id, {});
	const touched = sources.sources.filter((source) => source.runId === run?.id);
	expect(touched.map((source) => source.resource)).toEqual(
		expect.arrayContaining([
			"account:activity",
			"account:factory",
			"account:repos",
			"account:issues",
			"account:ci",
		]),
	);
	expect(touched.every((source) => source.fetchedAt === run?.publishedAt)).toBe(true);
	const activity = await readActivity(createDb(env.DB), snap.account_id, {});
	expect(activity).toMatchObject({
		runId: "r1",
		previousRunId: null,
		window: { first: true, gap: true },
		repos: [{ repo: "nocoo/app", ci_runs: [], commits: { default: 1, other: 0 } }],
	});
	expect(run?.steps.find((step) => step.kind === "activity")).toMatchObject({
		status: "success",
		pages: 2,
	});
	expect(
		(
			await createDb(env.DB)
				.prepare(
					"SELECT payload FROM factory_resources WHERE run_id='r1' AND stream='activity-snapshot'",
				)
				.first<{ payload: string }>()
		)?.payload,
	).toContain('"repo":"nocoo/app"');

	expect(run?.steps.find((step) => step.kind === "contributions")).toMatchObject({
		status: "success",
		pages: 3,
	});
	expect(
		(await publishedFactory(createDb(env.DB), snap.account_id))?.contribution?.days,
	).toHaveLength(30);
	for (const kind of ["repos", "issues", "prs", "notifications", "insights"]) {
		const saved = await readSnapshot(createDb(env.DB), snap.account_id, kind);
		expect(saved, kind).not.toBeNull();
		if (["issues", "prs", "insights"].includes(kind))
			expect(saved?.repository_fetched_at).toEqual({ "nocoo/app": now });
	}
	expect(run?.steps.find((step) => step.resource === "insights")?.status).toBe("success");
	await createDb(env.DB).prepare("UPDATE accounts SET is_active=1").run();
	await createDb(env.DB)
		.prepare("INSERT INTO repo_stars(account_id,repo) VALUES(?,?)")
		.bind(snap.account_id, "nocoo/app")
		.run();
	for (const kind of ["issues", "prs", "insights"]) {
		const response = await createApp().request(
			`http://localhost/api/${kind}?scope=starred`,
			{},
			env,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			truncated: false,
			freshness: { missing: 0, latestAt: now },
		});
	}
	expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/notifications"))).toBe(
		true,
	);
	expect(
		vi
			.mocked(fetch)
			.mock.calls.some(([, init]) => String(init?.body).includes("contributionsCollection")),
	).toBe(true);
});
it("publishes only a complete committed repository set and survives every-page restarts", async () => {
	const env = await setup();
	await executeRunPage(env, "r1", () => now);
	expect((await publishedFactory(createDb(env.DB), snap.account_id))?.runId).toBe(snap.runId);
	await drive(env);
	expect((await getRun(createDb(env.DB), snap.account_id, "r1"))?.run.status).toBe("partial"); // contribution unavailable
	const published = await publishedFactory(createDb(env.DB), snap.account_id);
	expect(published?.runId).toBe("r1");
	expect(published?.repos[0]?.observation?.version).toBe("r1");
	if (!published) throw new Error("missing publication");
	const streams = await createDb(env.DB)
		.prepare(
			"SELECT repo,stream,payload,content_meta FROM factory_resources WHERE run_id='r1' AND repo!='' AND content_meta IS NOT NULL",
		)
		.all<{ repo: string; stream: string; payload: string; content_meta: string }>();
	expect(streams.results).toHaveLength(7);
	for (const row of streams.results) {
		const data = JSON.parse(row.payload);
		expect(data.ranges).toEqual([]);
		expect(JSON.parse(row.content_meta)).toEqual({
			hash: await contentVersion(`factory:${row.repo}:${row.stream}`, {
				...data,
				ranges: [published.window],
			}),
			fullVersion: await observationVersion(data),
			version: "r1",
		});
	}
	const count = vi.mocked(fetch).mock.calls.length;
	await executeRunPage(env, "r1", () => now);
	expect(fetch).toHaveBeenCalledTimes(count);
});

it("refreshes one repository without scanning or rewriting unrelated site data", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const db = createDb(env.DB);
	const other = structuredClone(snap.repos[0]);
	if (!other) throw new Error("fixture repository missing");
	other.id = "other";
	other.name = "org/other";
	other.observation = {
		version: "old",
		refreshedAt: now,
		window: snap.window,
		source: "run",
		repo: other.name,
	};
	const calendar = { total: 2, restricted: 0, days: [], fetchedAt: now };
	const observation = { version: "old", window: snap.window, fetchedAt: now };
	await db.batch(
		await replaceSnapshotStmts(
			db,
			snap.account_id,
			"factory",
			{
				...snap,
				repos: [...snap.repos, other],
				contribution: calendar,
				contributionStatus: "complete",
				contributionObservation: observation,
			},
			now,
		),
	);
	const preserved: Record<string, Record<string, unknown>> = {
		repos: {
			repos: [{ name_with_owner: "nocoo/app" }, { name_with_owner: "org/other" }],
			truncated: false,
		},
		issues: { issues: [{ repo: "org/other", number: 1 }], truncated: false },
		prs: { pull_requests: [{ repo: "org/other", number: 2 }], truncated: false },
		alerts: { items: [], truncated: false },
		notifications: { notifications: [], truncated: false },
		insights: { marker: "original insights" },
		"repo:org/other:details": { description: "Retain other repository" },
	};
	for (const [kind, payload] of Object.entries(preserved))
		await db.batch(
			await replaceSnapshotStmts(db, snap.account_id, kind, { ...payload, fetched_at: now }, now),
		);
	const originals = new Map(
		await Promise.all(
			Object.keys(preserved).map(
				async (kind) => [kind, await readSnapshot(db, snap.account_id, kind)] as const,
			),
		),
	);
	const later = new Date(Date.parse(now) + 30_000).toISOString();
	const run = await drive(env, later);
	expect(run?.steps).toHaveLength(19);
	expect(run?.status).toBe("completed");
	expect(run?.steps.find((step) => step.kind === "alerts")).toMatchObject({
		status: "success",
		attempts: 1,
		pages: 1,
	});
	expect(run?.steps.find((step) => step.kind === "commit")?.status).toBe("success");
	expect(run?.steps.map((step) => step.kind)).not.toContain("assessment");
	for (const [kind, payload] of originals) {
		const next = await readSnapshot(db, snap.account_id, kind);
		if (["repos", "issues", "prs", "alerts"].includes(kind)) {
			expect(next?.fetched_at).toBe(payload?.fetched_at);
			expect(next?.repository_fetched_at).toEqual({ "nocoo/app": later });
			if (kind === "repos")
				expect(
					((next?.repos ?? []) as { name_with_owner: string }[]).find(
						(repo) => repo.name_with_owner === "org/other",
					),
				).toEqual({ name_with_owner: "org/other" });
		} else expect(next).toEqual(payload);
	}
	for (const [url, init] of vi.mocked(fetch).mock.calls) {
		const body = String(init?.body ?? "");
		expect(String(url)).not.toContain("/notifications");
		expect(body).not.toMatch(/contributionsCollection|affiliations:|org\/other/);
		if (body.includes("search(query"))
			expect(JSON.parse(body).variables.q.match(/repo:\S+/g)).toEqual(["repo:nocoo/app"]);
	}
	const published = await publishedFactory(db, snap.account_id);
	expect(published?.repos.find((repo) => repo.name === "org/other")).toEqual(other);
	expect(published?.repos.find((repo) => repo.name === "nocoo/app")?.observation?.version).toBe(
		"r1",
	);
	expect(published?.contribution).toEqual(calendar);
	expect(published?.contributionObservation).toEqual(observation);
	expect(published?.contributionStatus).toBe("complete");
	expect(published?.publication?.mixed).toBe(true);
	expect(await readSnapshot(db, snap.account_id, "repo:nocoo/app:details")).toMatchObject({
		fetched_at: later,
	});
});

async function drive(env: Env, start = now) {
	let at = start;
	for (let i = 0; i < 80; i++) {
		const found = await getRun(createDb(env.DB), snap.account_id, "r1");
		if (found?.run.status !== "running") return found?.run;
		at = found.run.nextAttemptAt > at ? found.run.nextAttemptAt : at;
		await executeRunPage(env, "r1", () => at);
	}
	throw new Error("run did not terminate");
}

async function beforeMetadata(env: Env) {
	const endReason = FactoryInvocation.prototype.endReason;
	const boundary = vi.spyOn(FactoryInvocation.prototype, "endReason").mockImplementation(function (
		this: FactoryInvocation,
		step,
		parallel,
	) {
		return step.kind === "metadata" ? "yield" : endReason.call(this, step, parallel);
	});
	try {
		for (let index = 0; index < 20; index++) {
			const found = await getRun(createDb(env.DB), snap.account_id, "r1");
			if (found?.run.steps[found.run.cursor]?.kind === "metadata") return;
			await executeRunPage(env, "r1", () => now);
		}
		throw new Error("metadata step not reached");
	} finally {
		boundary.mockRestore();
	}
}

async function executeMetadata(env: Env) {
	const endReason = FactoryInvocation.prototype.endReason;
	const boundary = vi.spyOn(FactoryInvocation.prototype, "endReason").mockImplementation(function (
		this: FactoryInvocation,
		step,
		parallel,
	) {
		return step.kind === "metadata" ? endReason.call(this, step, parallel) : "yield";
	});
	try {
		await executeRunPage(env, "r1", () => now);
	} finally {
		boundary.mockRestore();
	}
}

it.each([false, true])(
	"timestamps metadata rates and preserves prior observations when absent (rate: %s)",
	async (hasRate) => {
		const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
		await beforeMetadata(env);
		const db = createDb(env.DB);
		const observedAt = new Date(Date.parse(now) - 60_000).toISOString();
		const previous = {
			remaining: 500,
			resetAt: "2026-09-15T23:00:00Z",
			resource: "core",
			observedAt,
		};
		await db
			.prepare(
				"UPDATE factory_runs SET payload=json_set(payload,'$.checkpoint',json(?)) WHERE id='r1'",
			)
			.bind(JSON.stringify({ ...snap, rate: previous }))
			.run();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					data: {
						repository: rawRepo,
						...(hasRate ? { rateLimit: { remaining: 400, resetAt: "2026-09-15T23:00:00Z" } } : {}),
					},
				}),
			),
		);
		await executeMetadata(env);
		expect((await getRun(db, snap.account_id, "r1"))?.run.checkpoint?.rate).toEqual(
			hasRate
				? { remaining: 400, resetAt: "2026-09-15T23:00:00Z", resource: "graphql", observedAt: now }
				: previous,
		);
	},
);

async function legacyAssessment(status: "pending" | "running" | "success") {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const db = createDb(env.DB);
	env.FACTORY_QUEUE = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Queue;
	for (let page = 0; page < 50; page++) {
		const found = await getRun(db, snap.account_id, "r1");
		if (found?.run.steps[found.run.cursor]?.kind === "publish") {
			const steps = found.run.steps.filter((step) => String(step.kind) !== "assessment");
			const template = steps[0];
			const publish = steps.at(-1);
			if (!template || !publish) throw new Error("fixture");
			const run = {
				...found.run,
				cursor: steps.length - 1,
				steps: [
					...steps.slice(0, -1),
					{
						...template,
						kind: "assessment",
						status,
						assessmentStage: "summary",
						startedAt: status === "pending" ? null : now,
						finishedAt: status === "success" ? now : null,
					},
					publish,
				],
			};
			await db
				.prepare("UPDATE factory_runs SET payload=? WHERE id=?")
				.bind(JSON.stringify(run), run.id)
				.run();
			await db
				.prepare(
					"INSERT INTO ai_reviews(account_id,repo,job_id,source_version,source_at,stage,report,report_version,next_at) VALUES(?,?,'old-review',?,?,'summary','{\"saved\":true}','old-source',?)",
				)
				.bind(snap.account_id, "nocoo/app", run.id, now, now)
				.run();
			return { env, db, run };
		}
		const canStart = FactoryInvocation.prototype.canStart;
		const boundary = vi.spyOn(FactoryInvocation.prototype, "canStart").mockImplementation(function (
			this: FactoryInvocation,
			step,
		) {
			return step.kind !== "publish" && canStart.call(this, step);
		});
		try {
			await executeRunPage(env, "r1", () => now);
		} finally {
			boundary.mockRestore();
		}
	}
	throw new Error("publication checkpoint missing");
}

it.each(["pending", "running"] as const)(
	"retires a persisted %s cloud analysis without changing saved evidence or the frozen plan",
	async (status) => {
		const { env, db, run } = await legacyAssessment(status);
		const tables = [
			"snapshots",
			"factory_repo_state",
			"factory_repo_versions",
			"factory_resources",
			"ai_reviews",
		];
		const previous = await Promise.all(
			tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
		);
		const calls = vi.mocked(fetch).mock.calls.length;
		Reflect.deleteProperty(env, "TOKEN_ENCRYPTION_KEY_V1");
		expect(await executeRunPage(env, run.id, () => now)).toBe(now);
		const saved = await getRun(db, snap.account_id, run.id);
		expect(saved?.run).toMatchObject({ status: "running", finishedAt: null });
		expect(saved?.leaseUntil).toBeNull();
		expect(saved?.run.steps.find((step) => String(step.kind) === "assessment")).toMatchObject({
			status: "skipped",
			error: "cloud_ai_retired",
			finishedAt: now,
		});
		expect(saved?.run.steps.at(-1)).toMatchObject({
			kind: "publish",
			status: "pending",
			error: null,
		});
		expect(saved?.run.steps.filter((step) => String(step.kind) !== "assessment")).toEqual(
			run.steps.filter((step) => step.kind !== "assessment"),
		);
		expect(
			await Promise.all(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())),
		).toEqual(previous);
		expect((await publishedFactory(db, snap.account_id))?.runId).toBe(snap.runId);
		expect((await drive(env))?.status).toBe("completed");
		expect((await publishedFactory(db, snap.account_id))?.runId).toBe(run.id);
		expect(fetch).toHaveBeenCalledTimes(calls);
		expect(env.FACTORY_QUEUE.send).not.toHaveBeenCalled();
	},
);
it("resumes paused collection past retired cloud analysis without extending repository cooldowns", async () => {
	const { env, db, run } = await legacyAssessment("running");
	const previous = await db.prepare("SELECT * FROM factory_repo_state").all();
	await controlRun(db, snap.account_id, run.id, "pause", now);
	expect(await executeRunPage(env, run.id, () => now)).toBeNull();
	expect((await getRun(db, snap.account_id, run.id))?.run.status).toBe("paused");
	await controlRun(db, snap.account_id, run.id, "resume", now);
	expect(await executeRunPage(env, run.id, () => now)).toBe(now);
	expect((await getRun(db, snap.account_id, run.id))?.run.status).toBe("running");
	expect(await db.prepare("SELECT * FROM factory_repo_state").all()).toEqual(previous);
	expect((await drive(env))?.status).toBe("completed");
});

it("fences retirement against an expired lease and recovers on the next claim", async () => {
	const { env, db, run } = await legacyAssessment("pending");
	const expired = new Date(Date.parse(now) + RUN_LEASE_MS).toISOString();
	const clock = vi.fn().mockReturnValue(expired).mockReturnValueOnce(now);
	expect(await executeRunPage(env, run.id, clock)).toBeNull();
	expect((await getRun(db, snap.account_id, run.id))?.run).toMatchObject({
		status: "running",
		steps: run.steps,
	});
	expect(await executeRunPage(env, run.id, () => expired)).toBe(expired);
	expect((await getRun(db, snap.account_id, run.id))?.run.steps[run.cursor]).toMatchObject({
		status: "skipped",
		error: "cloud_ai_retired",
	});
	expect((await publishedFactory(db, snap.account_id))?.runId).toBe(snap.runId);
	expect((await drive(env, expired))?.status).toBe("completed");
});

it("continues queued collection work after retiring future cloud assessment steps", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(now);
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const send = vi.fn();
	env.FACTORY_QUEUE = { send } as unknown as Queue;
	const db = createDb(env.DB);
	const found = await getRun(db, snap.account_id, "r1");
	if (!found) throw new Error("fixture");
	const steps = found.run.steps.filter((step) => String(step.kind) !== "assessment");
	const template = steps[0];
	const publish = steps.at(-1);
	if (!template || !publish) throw new Error("fixture");
	await db
		.prepare("UPDATE factory_runs SET payload=? WHERE id='r1'")
		.bind(
			JSON.stringify({
				...found.run,
				steps: [...steps.slice(0, -1), { ...template, kind: "assessment" }, publish],
			}),
		)
		.run();
	const calls = vi.mocked(fetch).mock.calls.length;
	const ack = vi.fn();
	const retry = vi.fn();
	await consumeFactory(
		{ messages: [{ body: { id: "r1" }, ack, retry }] } as unknown as MessageBatch<unknown>,
		env,
	);
	expect(ack).toHaveBeenCalledTimes(1);
	expect(retry).not.toHaveBeenCalled();
	expect(send).toHaveBeenCalledExactlyOnceWith({ id: "r1" }, { delaySeconds: 0 });
	expect(fetch).toHaveBeenCalledTimes(calls);
	const retired = await getRun(db, snap.account_id, "r1");
	expect(retired?.run).toMatchObject({ status: "running", cursor: 0, checkpoint: null });
	expect(retired?.run.steps.filter((step) => String(step.kind) !== "assessment")).toEqual(steps);
	expect((await drive(env))?.status).toBe("completed");
	expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(calls);
	expect((await publishedFactory(db, snap.account_id))?.runId).toBe("r1");
});

it("allows publication after an already completed historical analysis without restarting it", async () => {
	const { env, db, run } = await legacyAssessment("success");
	const calls = vi.mocked(fetch).mock.calls.length;
	expect(await executeRunPage(env, run.id, () => now)).toBeNull();
	expect((await getRun(db, snap.account_id, run.id))?.run.status).toBe("completed");
	expect((await publishedFactory(db, snap.account_id))?.runId).toBe(run.id);
	expect(fetch).toHaveBeenCalledTimes(calls);
	expect(env.FACTORY_QUEUE.send).not.toHaveBeenCalled();
});
it("retries a failing repository with backoff, preserves old data, and still publishes a consistent version", async () => {
	const env = await setup();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, init) =>
			String(init?.body).includes("contributionsCollection")
				? Response.json({ data: { user: null } })
				: Response.json({ message: "temporary failure" }, { status: 500 }),
		),
	);
	const run = await drive(env);
	expect(run?.status).toBe("partial");
	expect(run?.steps.find((s) => s.kind === "metadata")).toMatchObject({
		status: "failed",
		attempts: 4,
		error: "github_error",
	});
	expect(run?.steps.filter((s) => s.status === "skipped")).toHaveLength(8);
	expect((await publishedFactory(createDb(env.DB), snap.account_id))?.repos).toHaveLength(1);
	const { repoStates } = await import("./db/factory-runs");
	expect((await repoStates(createDb(env.DB), snap.account_id))[0]).toMatchObject({
		status: "failed",
		error: "github_error",
	});
});
it("keeps rate-limit deadlines on disk and cannot resume early after pause", async () => {
	const env = await setup();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({ message: "limited" }, { status: 429, headers: { "retry-after": "3600" } }),
		),
	);
	await executeRunPage(env, "r1", () => now);
	const found = await getRun(createDb(env.DB), snap.account_id, "r1");
	expect(found?.run.status).toBe("running");
	expect(Date.parse(found?.run.nextAttemptAt ?? "")).toBeGreaterThan(Date.parse(now) + 899000);
	const { controlRun } = await import("./db/factory-runs");
	await controlRun(createDb(env.DB), snap.account_id, "r1", "pause", now);
	await controlRun(createDb(env.DB), snap.account_id, "r1", "resume", now);
	const count = vi.mocked(fetch).mock.calls.length;
	await executeRunPage(env, "r1", () => now);
	expect(fetch).toHaveBeenCalledTimes(count);
});
it("pauses for invalid credentials or a missing encryption key without erasing snapshots", async () => {
	for (const mode of ["401", "key"]) {
		const env = await setup();
		if (mode === "key") Reflect.deleteProperty(env, "TOKEN_ENCRYPTION_KEY_V1");
		vi.stubGlobal("fetch", async () =>
			Response.json({ message: "private token detail" }, { status: 401 }),
		);
		await executeRunPage(env, "r1", () => now);
		const found = await getRun(createDb(env.DB), snap.account_id, "r1");
		expect(found?.run.status).toBe("paused");
		expect(JSON.stringify(found)).not.toContain("private token detail");
		expect((await publishedFactory(createDb(env.DB), snap.account_id))?.runId).toBe(snap.runId);
	}
});
it("discovers inventory and restores legacy resource evidence with original window and timestamps", async () => {
	const env = await setup("catalog");
	const { ready } = await import("../../../../../tests/fixtures/factory");
	const { memoryStore, github } = await import("../../../../../tests/fixtures/factory");
	const { stepFactory } = await import("./factory-collect");
	const state = ready();
	const store = memoryStore();
	const gh = github((url) =>
		Response.json(
			url.includes("graphql")
				? { data: { repository: {} } }
				: url.includes("actions/runs")
					? { total_count: 0, workflow_runs: [] }
					: [],
		),
	);
	for (let i = 0; i < 7; i++) await stepFactory(state, gh, "fake", store, now);
	for (const [kind, data] of store.data) {
		const db = createDb(env.DB);
		await db.batch(await replaceSnapshotStmts(db, snap.account_id, kind, { ...data }, now));
	}
	vi.stubGlobal("fetch", async () =>
		Response.json({
			data: {
				viewer: {
					login: "nocoo",
					repositories: { totalCount: 1, nodes: [rawRepo], pageInfo: { hasNextPage: false } },
				},
			},
		}),
	);
	const run = await drive(env);
	expect(run?.status).toBe("completed");
	const published = await publishedFactory(createDb(env.DB), snap.account_id);
	expect(published?.repos[0]?.observation).toMatchObject({ source: "legacy", refreshedAt: now });
	expect(published?.repos[0]?.coverage.commits.status).toBe("complete");
	expect(published?.publication?.mixed).toBe(true);
});
it("discovers an empty catalog without fabricated observations", async () => {
	const env = await setup("catalog");
	vi.stubGlobal("fetch", async () =>
		Response.json({
			data: {
				viewer: {
					login: "nocoo",
					repositories: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
				},
			},
		}),
	);
	expect((await drive(env))?.status).toBe("completed");
	expect((await publishedFactory(createDb(env.DB), snap.account_id))?.repos).toEqual([]);
});

it.each([null, "", 7, "same"])(
	"rejects invalid catalog continuation %s without clearing old repositories",
	async (endCursor) => {
		const env = await setup("catalog");
		const db = createDb(env.DB);
		const old = {
			truncated: false,
			fetched_at: "2025-01-01T00:00:00.000Z",
			repos: [{ name_with_owner: "nocoo/app" }],
		};
		await db.batch(await replaceSnapshotStmts(db, snap.account_id, "repos", old, old.fetched_at));
		let catalogPages = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				if (String(init?.body).includes("ownerAffiliations"))
					return Response.json({
						data: {
							viewer: {
								login: "nocoo",
								repositories: { totalCount: 1, nodes: [rawRepo], pageInfo: { hasNextPage: false } },
							},
						},
					});
				catalogPages++;
				return Response.json({
					data: {
						viewer: {
							repositories: {
								nodes: [],
								pageInfo: { hasNextPage: true, endCursor },
							},
						},
					},
				});
			}),
		);
		const run = await drive(env);
		expect(run?.steps.find((step) => step.resource === "repos")).toMatchObject({
			status: "failed",
			error: "snapshot_incomplete",
			attempts: 1,
		});
		expect(catalogPages).toBe(endCursor === "same" ? 2 : 1);
		expect(run?.status).toBe("failed");
		expect(await publishedFactory(db, snap.account_id)).toMatchObject({ runId: snap.runId });
		expect((await listRuns(db, snap.account_id))[0]?.counts.failed).toBeGreaterThanOrEqual(1);
		expect(await readSnapshot(db, snap.account_id, "repos")).toEqual(old);
	},
);
it("checkpoints pagination once, deduplicates overlapping pages and exposes immutable details", async () => {
	const env = await setup();
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			if (url.includes("/issues?"))
				return Response.json(
					[
						{
							id: 1,
							node_id: "one",
							title: "work",
							state: "open",
							created_at: "2026-09-01T00:00:00Z",
							user: { login: "nocoo" },
						},
					],
					{
						headers:
							new URL(url).searchParams.get("page") === "1"
								? { link: '<https://api.github.com/repos/nocoo/app/issues?page=2>; rel="next"' }
								: {},
					},
				);
			return base(url, init);
		}),
	);
	const run = await drive(env);

	expect(run?.steps.find((s) => s.kind === "issues")).toMatchObject({
		pages: 2,
		status: "success",
	});
	expect(
		(await publishedFactory(createDb(env.DB), snap.account_id))?.repos[0]?.metrics.issueOpened,
	).toBe(1);
	const { createApp } = await import("../index");
	const app = createApp();
	await createDb(env.DB).prepare("UPDATE accounts SET is_active=1").run();
	const detail = await app.request("http://localhost/api/factory/repos/nocoo/app/issues", {}, env);
	expect(detail.status).toBe(200);
	expect(await detail.json()).toMatchObject({ total: 1, runId: "r1" });
});
it("fences a page that completes after pause, then resumes from the last committed page", async () => {
	const env = await setup();
	let release: (r: Response) => void = () => {};
	vi.stubGlobal(
		"fetch",
		vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					release = resolve;
				}),
		),
	);
	const running = executeRunPage(env, "r1", () => now);
	await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
	const { controlRun } = await import("./db/factory-runs");
	await controlRun(createDb(env.DB), snap.account_id, "r1", "pause", now);
	release(Response.json({ data: { user: null } }));
	expect(await running).toBeNull();
	expect((await getRun(createDb(env.DB), snap.account_id, "r1"))?.run.requests).toBe(0);
});

it("records unavailable coverage, metadata limits, catalog failure and malformed checkpoints honestly", async () => {
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	const modes = [
		"coverage",
		"identity",
		"rate",
		"inventory",
		"checkpoint",
		"capacity",
		"contributions",
	] as const;
	for (const mode of modes) {
		const env = await setup(mode === "inventory" ? "catalog" : "refresh");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				const query = String(init?.body);
				if (mode === "inventory")
					return Response.json({
						data: { viewer: { login: "wrong", repositories: { nodes: [] } } },
					});
				if (mode === "identity" && query.includes("nameWithOwner"))
					return Response.json({ data: { repository: { ...rawRepo, id: "different" } } });
				if (mode === "rate" && query.includes("nameWithOwner"))
					return Response.json({
						data: {
							repository: rawRepo,
							rateLimit: { remaining: 0, resetAt: "2099-01-01T00:00:00.000Z" },
						},
					});
				if (mode === "capacity" && query.includes("nameWithOwner"))
					return Response.json({
						data: { repository: { ...rawRepo, description: "x".repeat(1_800_001) } },
					});
				if (mode === "coverage" && url.includes("/dependabot/"))
					return Response.json({ message: "forbidden" }, { status: 403 });
				if (mode === "contributions" && query.includes("contributionsCollection"))
					return Response.json({
						data: {
							user: {
								contributionsCollection: {
									contributionCalendar: { totalContributions: 1, weeks: [] },
									restrictedContributionsCount: 0,
								},
							},
						},
					});
				return base(url, init);
			}),
		);
		if (mode === "checkpoint") {
			const found = await getRun(createDb(env.DB), snap.account_id, "r1");
			if (!found) throw new Error("fixture");
			found.run.cursor = found.run.steps.findIndex((step) => step.kind === "commit");
			await createDb(env.DB)
				.prepare("UPDATE factory_runs SET payload=? WHERE id=?")
				.bind(JSON.stringify(found.run), "r1")
				.run();
		}
		if (mode === "rate") {
			await beforeMetadata(env);
			await executeRunPage(env, "r1", () => now);
			await executeRunPage(env, "r1", () => now);
			expect((await getRun(createDb(env.DB), snap.account_id, "r1"))?.run.nextAttemptAt).toBe(
				"2099-01-01T00:00:00.000Z",
			);
		} else {
			const run = await drive(env);
			expect(run?.status).toBe(
				mode === "inventory" ? "failed" : mode === "capacity" ? "paused" : "partial",
			);
			if (mode === "coverage")
				expect(run?.steps.find((s) => s.kind === "alerts")?.error).toBe("coverage_unavailable");
			if (mode === "contributions")
				expect(
					(await publishedFactory(createDb(env.DB), snap.account_id))?.contribution?.total,
				).toBeUndefined();
		}
	}
});

it("rechecks repository cooldown at execution after a competing run commits during planning", async () => {
	const env = await setup();
	await beforeMetadata(env);
	await createDb(env.DB)
		.prepare("INSERT INTO factory_repo_state(account_id,repo,payload) VALUES(?,?,?)")
		.bind(
			snap.account_id,
			"nocoo/app",
			JSON.stringify({ repo: "nocoo/app", nextAllowedAt: "2999-01-01T00:00:00.000Z" }),
		)
		.run();
	const calls = vi.mocked(fetch).mock.calls.length;
	await executeMetadata(env);
	expect(fetch).toHaveBeenCalledTimes(calls);
	const run = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	expect(run?.steps.filter((s) => s.status === "skipped")).toHaveLength(9);
});

it("uses server time for persisted heartbeat when no clock is injected", async () => {
	const env = await setup();
	const before = Date.now();
	await executeRunPage(env, "r1");
	const run = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	expect(Date.parse(run?.updatedAt ?? "")).toBeGreaterThanOrEqual(before);
});

it("R9 resumed legacy runs finish without claiming atomic publication readiness", async () => {
	const env = await setup();
	const db = createDb(env.DB);
	const found = await getRun(db, snap.account_id, "r1");
	if (!found) throw new Error("fixture");
	const legacy = { ...found.run } as Record<string, unknown>;
	delete legacy.atomicPublication;
	for (const step of found.run.steps) if (step.kind !== "publish") step.status = "success";
	await db
		.prepare("UPDATE factory_runs SET payload=? WHERE id='r1'")
		.bind(JSON.stringify(legacy))
		.run();
	await executeRunPage(env, "r1", () => now);
	const saved = (await getRun(db, snap.account_id, "r1"))?.run;
	expect(saved?.status).toBe("completed");
	expect(saved?.publishedAt).toBeNull();
});

it("never revives completed steps on claim and finalizes exhausted persisted plans", async () => {
	for (const exhausted of [false, true]) {
		const env = await setup();
		const found = await getRun(createDb(env.DB), snap.account_id, "r1");
		if (!found) throw new Error("fixture");
		for (const step of found.run.steps)
			if (exhausted || step.kind === "contributions") step.status = "success";
		await createDb(env.DB)
			.prepare("UPDATE factory_runs SET payload=? WHERE id=?")
			.bind(JSON.stringify(found.run), "r1")
			.run();
		await executeRunPage(env, "r1", () => now);
		const saved = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
		expect(saved?.steps[0]?.status).toBe("success");
		expect(saved?.status).toBe(exhausted ? "completed" : "running");
	}
});
it("finishes activity factory_capacity as limited without pausing the run", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] }, true);
	const db = createDb(env.DB);
	const found = await getRun(db, snap.account_id, "r1");
	if (!found) throw new Error("fixture");
	for (const step of found.run.steps) {
		if (step.kind === "activity" && step.status === "pending") {
			found.run.cursor = found.run.steps.indexOf(step);
			break;
		}
		if (step.status === "pending") step.status = "success";
	}
	await db
		.prepare("UPDATE factory_runs SET payload=? WHERE id=?")
		.bind(JSON.stringify(found.run), "r1")
		.run();
	vi.spyOn(factoryPublish, "currentRepo").mockResolvedValue(mapFactoryRepo(rawRepo));
	vi.spyOn(activityLanded, "collectLandedPage").mockRejectedValue(
		new ApiError(422, "factory_capacity", "Activity repository metadata exceeds page capacity"),
	);
	await executeRunPage(env, "r1", () => now);
	const run = (await getRun(db, snap.account_id, "r1"))?.run;
	expect(run?.status).toBe("running");
	expect(run?.steps.find((step) => step.kind === "activity")).toMatchObject({
		status: "limited",
		error: "factory_capacity",
	});
	expect((await listRuns(db, snap.account_id))[0]?.counts).toMatchObject({ limited: 1 });
	expect(
		await db
			.prepare(
				"SELECT 1 AS ok FROM factory_resources WHERE run_id='r1' AND stream='activity-snapshot'",
			)
			.first(),
	).toBeNull();
	vi.restoreAllMocks();
});
it("keeps incomplete landed activity pending on factory_capacity when the invocation made GitHub progress", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] }, true);
	const db = createDb(env.DB);
	const found = await getRun(db, snap.account_id, "r1");
	if (!found) throw new Error("fixture");
	for (const step of found.run.steps) {
		if (step.kind === "activity" && step.status === "pending") {
			found.run.cursor = found.run.steps.indexOf(step);
			break;
		}
		if (step.status === "pending") step.status = "success";
	}
	await db
		.prepare("UPDATE factory_runs SET payload=? WHERE id=?")
		.bind(JSON.stringify(found.run), "r1")
		.run();
	vi.spyOn(factoryPublish, "currentRepo").mockResolvedValue(mapFactoryRepo(rawRepo));
	vi.spyOn(activityLanded, "collectLandedPage").mockImplementation(
		async (_db, _lease, _repo, gh, token) => {
			await gh.githubApi(token, `/repos/nocoo/app/commits?sha=main&per_page=1`);
			throw new ApiError(422, "factory_capacity", "landed ledger capacity exceeded");
		},
	);
	await executeRunPage(env, "r1", () => now);
	const run = (await getRun(db, snap.account_id, "r1"))?.run;
	expect(run?.steps.find((step) => step.kind === "activity")).toMatchObject({
		status: "pending",
		error: null,
	});
	expect((await listRuns(db, snap.account_id))[0]?.counts).toMatchObject({ limited: 0 });
	vi.restoreAllMocks();
});
it("persists staged landed writes when run-record factory_capacity follows collectLandedPage", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] }, true);
	const db = createDb(env.DB);
	const found = await getRun(db, snap.account_id, "r1");
	if (!found) throw new Error("fixture");
	const repo = snap.repos[0];
	if (!repo) throw new Error("fixture");
	for (const step of found.run.steps) {
		if (step.kind === "activity" && step.status === "pending") {
			found.run.cursor = found.run.steps.indexOf(step);
			break;
		}
		if (step.status === "pending") step.status = "success";
	}
	const metadata = found.run.steps.find(
		(step) => step.kind === "metadata" && step.repo === repo.name,
	);
	if (metadata) metadata.sourceHead = "abc123";
	const landedWrite = db
		.prepare(
			"INSERT INTO activity_commit_heads(account_id,repo_id,head,pending) VALUES(?,?,?,?) ON CONFLICT(account_id,repo_id) DO UPDATE SET pending=excluded.pending",
		)
		.bind(snap.account_id, repo.id, null, '{"head":"abc123","page":2}');
	vi.spyOn(activityLanded, "collectLandedPage").mockResolvedValue({
		done: false,
		writes: [landedWrite],
	});
	const bounded = vi.spyOn(factoryPublish, "boundedJson").mockImplementation((value) => {
		if (typeof value === "object" && value !== null && "steps" in value)
			throw new ApiError(422, "factory_capacity", "run record exceeds capacity");
		return JSON.stringify(value);
	});
	vi.spyOn(factoryPublish, "currentRepo").mockResolvedValue(mapFactoryRepo(rawRepo));
	await db
		.prepare("UPDATE factory_runs SET payload=? WHERE id=?")
		.bind(JSON.stringify(found.run), "r1")
		.run();
	await executeRunPage(env, "r1", () => now);
	expect(
		await db
			.prepare("SELECT pending FROM activity_commit_heads WHERE account_id=? AND repo_id=?")
			.bind(snap.account_id, repo.id)
			.first<{ pending: string }>(),
	).toMatchObject({ pending: '{"head":"abc123","page":2}' });
	const run = (await getRun(db, snap.account_id, "r1"))?.run;
	const activity = run?.steps.find((step) => step.kind === "activity");
	expect(activity?.status).not.toBe("limited");
	expect(activity?.error).not.toBe("factory_capacity");
	bounded.mockRestore();
	vi.restoreAllMocks();
});
it("freezes activity evidence on factory_capacity when current-run streams exist", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] }, true);
	const db = createDb(env.DB);
	const found = await getRun(db, snap.account_id, "r1");
	if (!found) throw new Error("fixture");
	const repo = snap.repos[0];
	if (!repo) throw new Error("fixture");
	for (const step of found.run.steps) {
		if (step.kind === "activity" && step.status === "pending") {
			found.run.cursor = found.run.steps.indexOf(step);
			break;
		}
		if (step.status === "pending") step.status = "success";
	}
	const metadata = found.run.steps.find(
		(step) => step.kind === "metadata" && step.repo === repo.name,
	);
	if (metadata) {
		metadata.sourceHead = "abc123";
		metadata.sourceBranch = "main";
	}
	await db
		.prepare(
			"INSERT INTO activity_commit_heads(account_id,repo_id,head,pending) VALUES(?,?,?,NULL)",
		)
		.bind(snap.account_id, repo.id, "abc123")
		.run();
	for (const stream of FACTORY_STREAMS)
		await db
			.prepare("INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,?,?,?)")
			.bind(
				"r1",
				repo.name,
				stream,
				JSON.stringify({
					runId: "r1",
					items: [],
					next: null,
					ranges: [],
					coverage: { ...repo.coverage[stream], status: "complete" },
				}),
			)
			.run();
	await db
		.prepare("UPDATE factory_runs SET payload=? WHERE id=?")
		.bind(JSON.stringify(found.run), "r1")
		.run();
	vi.spyOn(factoryPublish, "currentRepo").mockResolvedValue(mapFactoryRepo(rawRepo));
	vi.spyOn(activityLanded, "collectLandedPage").mockRejectedValue(
		new ApiError(422, "factory_capacity", "Activity repository metadata exceeds page capacity"),
	);
	await executeRunPage(env, "r1", () => now);
	expect(
		await db
			.prepare(
				"SELECT 1 AS ok FROM factory_resources WHERE run_id='r1' AND repo=? AND stream='activity-snapshot'",
			)
			.bind(repo.name)
			.first(),
	).toBeTruthy();
	vi.restoreAllMocks();
});
it("freezes activity evidence on factory_capacity limited finish when landed is incomplete but streams exist", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] }, true);
	const db = createDb(env.DB);
	const found = await getRun(db, snap.account_id, "r1");
	if (!found) throw new Error("fixture");
	const repo = snap.repos[0];
	if (!repo) throw new Error("fixture");
	for (const step of found.run.steps) {
		if (step.kind === "activity" && step.status === "pending") {
			found.run.cursor = found.run.steps.indexOf(step);
			break;
		}
		if (step.status === "pending") step.status = "success";
	}
	const metadata = found.run.steps.find(
		(step) => step.kind === "metadata" && step.repo === repo.name,
	);
	if (metadata) {
		metadata.sourceHead = "abc123";
		metadata.sourceBranch = "main";
	}
	await db
		.prepare(
			"INSERT INTO activity_commit_heads(account_id,repo_id,head,pending) VALUES(?,?,?,?) ON CONFLICT(account_id,repo_id) DO UPDATE SET pending=excluded.pending",
		)
		.bind(snap.account_id, repo.id, null, '{"head":"abc123","page":1}')
		.run();
	for (const stream of FACTORY_STREAMS)
		await db
			.prepare("INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,?,?,?)")
			.bind(
				"r1",
				repo.name,
				stream,
				JSON.stringify({
					runId: "r1",
					items: [],
					next: null,
					ranges: [],
					coverage: { ...repo.coverage[stream], status: "complete" },
				}),
			)
			.run();
	await db
		.prepare("UPDATE factory_runs SET payload=? WHERE id=?")
		.bind(JSON.stringify(found.run), "r1")
		.run();
	vi.spyOn(factoryPublish, "currentRepo").mockResolvedValue(mapFactoryRepo(rawRepo));
	vi.spyOn(activityLanded, "collectLandedPage").mockRejectedValue(
		new ApiError(422, "factory_capacity", "Activity repository metadata exceeds page capacity"),
	);
	await executeRunPage(env, "r1", () => now);
	const run = (await getRun(db, snap.account_id, "r1"))?.run;
	expect(run?.steps.find((step) => step.kind === "activity")).toMatchObject({
		status: "limited",
		error: "factory_capacity",
	});
	expect(
		await db
			.prepare(
				"SELECT 1 AS ok FROM factory_resources WHERE run_id='r1' AND repo=? AND stream='activity-snapshot'",
			)
			.bind(repo.name)
			.first(),
	).toBeTruthy();
	vi.restoreAllMocks();
});

it("does not spend network retry budget while waiting for valid credentials", async () => {
	const env = await setup();
	const { controlRun } = await import("./db/factory-runs");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ message: "unauthorized" }, { status: 401 })),
	);
	for (let i = 0; i < 4; i++) {
		await executeRunPage(env, "r1", () => now);
		await controlRun(createDb(env.DB), snap.account_id, "r1", "resume", now);
	}
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({}, { status: 500 })),
	);
	await executeRunPage(env, "r1", () => now);
	const run = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	expect(run?.status).toBe("running");
	expect(run?.steps[0]).toMatchObject({ retryFailures: 1, attempts: 5, status: "pending" });
});
it("aborts before GitHub when a control invalidates the lease between claim and step start", async () => {
	const env = await setup();
	const prepare = env.DB.prepare.bind(env.DB);
	env.DB.prepare = (sql: string) => {
		if (sql.startsWith("UPDATE factory_run_journal SET journal=json_patch"))
			void prepare(
				"UPDATE factory_runs SET status='paused',lease_token=NULL,payload=json_set(payload,'$.status','paused') WHERE id='r1'",
			).run();
		return prepare(sql);
	};
	expect(await executeRunPage(env, "r1", () => now)).toBeNull();
	expect(fetch).not.toHaveBeenCalled();
});

it("retains an older contribution calendar with explicit provenance when the new collection is unavailable", async () => {
	const env = await setup();
	const old = {
		...snap,
		contributionStatus: "complete" as const,
		contribution: {
			total: 4,
			restricted: 1,
			days: [{ date: "2026-09-01", count: 4 }],
			fetchedAt: now,
		},
	};
	const db = createDb(env.DB);
	await db.batch(await replaceSnapshotStmts(db, snap.account_id, "factory", old, now));
	await drive(env);
	const published = await publishedFactory(createDb(env.DB), snap.account_id);
	expect(published?.contribution).toEqual(old.contribution);
	expect(published?.contributionStatus).toBe("unavailable");
	expect(published?.contributionObservation).toMatchObject({
		version: snap.runId,
		window: snap.window,
	});
	expect(published?.publication?.mixed).toBe(true);
});
it("keeps interrupted repository cooldown while allowing the same frozen run to resume", async () => {
	const env = await setup();
	const { controlRun, repoStates } = await import("./db/factory-runs");
	await beforeMetadata(env);
	await executeMetadata(env);
	await controlRun(createDb(env.DB), snap.account_id, "r1", "pause", now);
	expect((await repoStates(createDb(env.DB), snap.account_id))[0]).toMatchObject({
		attemptRunId: "r1",
		attemptStatus: "pause",
		nextAllowedAt: "2026-09-15T22:15:00.000Z",
	});
	await controlRun(createDb(env.DB), snap.account_id, "r1", "resume", now);
	expect((await drive(env))?.status).toBe("partial");
});
it("continues above the former quota and publishes through the normal fenced path", async () => {
	const env = await setup();
	await createDb(env.DB).prepare("UPDATE factory_budget SET bytes=?").bind(255_000_000).run();
	await executeRunPage(env, "r1", () => now);
	const run = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	expect(run?.status).toBe("running");
	expect(run?.steps[0]).toMatchObject({ error: null, status: "success" });
	expect((await publishedFactory(createDb(env.DB), snap.account_id))?.runId).toBe(snap.runId);
	await drive(env);
	expect((await publishedFactory(createDb(env.DB), snap.account_id))?.runId).toBe("r1");
});

it("does not shorten an existing repository cooldown on repeated pause/cancel controls", async () => {
	const env = await setup();
	const { controlRun, repoStates } = await import("./db/factory-runs");
	await beforeMetadata(env);
	await executeMetadata(env);
	await controlRun(createDb(env.DB), snap.account_id, "r1", "pause", now);
	await createDb(env.DB)
		.prepare(
			"UPDATE factory_repo_state SET payload=json_set(payload,'$.nextAllowedAt','2999-01-01T00:00:00.000Z')",
		)
		.run();
	await controlRun(createDb(env.DB), snap.account_id, "r1", "cancel", now);
	expect((await repoStates(createDb(env.DB), snap.account_id))[0]?.nextAllowedAt).toBe(
		"2999-01-01T00:00:00.000Z",
	);
});

it("refreshes all site pages through the durable run, including derived insights", async () => {
	const env = await setup();
	const db = createDb(env.DB);
	await db.prepare("UPDATE accounts SET is_active=1").run();
	await db.batch(
		await replaceSnapshotStmts(
			db,
			snap.account_id,
			"repos",
			{
				repos: [{ name_with_owner: "nocoo/app", description: "outdated" }],
				fetched_at: "2025-01-01",
				truncated: false,
			},
			"2025-01-01",
		),
	);
	const run = await drive(env);
	expect(run?.steps.filter((s) => s.kind === "snapshot").every((s) => s.status === "success")).toBe(
		true,
	);
	for (const kind of [
		"repos",
		"issues",
		"prs",
		"alerts",
		"notifications",
		"insights",
		"repo:nocoo/app:details",
		"repo:nocoo/app:traffic",
		"repo:nocoo/app:security",
		"repo:nocoo/app:actions",
		"repo:nocoo/app:issues",
		"repo:nocoo/app:prs",
		"repo:nocoo/app:releases",
		"repo:nocoo/app:languages",
		"repo:nocoo/app:contributors",
	]) {
		expect(await readSnapshot(createDb(env.DB), snap.account_id, kind), kind).toMatchObject({
			fetched_at: now,
			truncated: false,
		});
	}
	const app = createApp();
	const requests = vi.mocked(fetch).mock.calls.length;
	const saved = await db.prepare("SELECT * FROM snapshots ORDER BY kind").all();
	for (const resource of [
		"repos",
		"insights",
		"issues",
		"prs",
		"alerts",
		"notifications",
		"ci",
		"factory",
		"repos/nocoo/app",
		"repos/nocoo/app/actions",
		"repos/nocoo/app/traffic",
		"repos/nocoo/app/security",
		"repos/nocoo/app/issues",
		"repos/nocoo/app/prs",
		"repos/nocoo/app/releases",
		"repos/nocoo/app/languages",
		"repos/nocoo/app/contributors",
	]) {
		const response = await app.request(`http://localhost/api/${resource}`, {}, env);
		expect(response.status, resource).toBe(200);
		expect(await response.json(), resource).toMatchObject({
			account_id: snap.account_id,
			fetched_at: now,
		});
	}
	expect(fetch).toHaveBeenCalledTimes(requests);
	expect(await db.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(saved);
});

it("preserves Insights when its global sources fail and records the missing update explicitly", async () => {
	const env = await setup();
	const db = createDb(env.DB);
	const old = { fetched_at: "2025-01-01", truncated: false, insights: [{ marker: "old" }] };
	for (const [kind, payload] of Object.entries({
		repos: { repos: [{ name_with_owner: "nocoo/app" }], truncated: false },
		issues: { issues: [], truncated: false },
		alerts: { items: [], truncated: false },
		insights: old,
	}))
		await db.batch(await replaceSnapshotStmts(db, snap.account_id, kind, payload, old.fetched_at));
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) =>
			String(init?.body).includes("search(query")
				? Response.json({}, { status: 500 })
				: base(url, init),
		),
	);
	const run = await drive(env);
	expect(run?.steps.find((step) => step.resource === "insights")).toMatchObject({
		status: "failed",
		error: "snapshot_sources_incomplete",
		attempts: 1,
	});
	expect(await readSnapshot(db, snap.account_id, "insights")).toEqual(old);
	expect(await readSnapshot(db, snap.account_id, "repos")).toMatchObject({ fetched_at: now });
	expect(await readSnapshot(db, snap.account_id, "notifications")).toMatchObject({
		fetched_at: run?.steps.find((step) => step.resource === "notifications")?.finishedAt,
	});
});

it("updates Insights independently of notifications and clears an old incomplete-alert warning", async () => {
	const env = await setup();
	const db = createDb(env.DB);
	await db.batch(
		await replaceSnapshotStmts(
			db,
			snap.account_id,
			"insights",
			{
				fetched_at: "2025-01-01",
				truncated: false,
				alerts_incomplete: true,
				insights: [],
			},
			"2025-01-01",
		),
	);
	await db
		.prepare("UPDATE accounts SET capabilities=?")
		.bind(JSON.stringify({ repo: true }))
		.run();
	const run = await drive(env);
	expect(run?.steps.find((step) => step.resource === "notifications")?.status).toBe("unavailable");
	expect(run?.steps.find((step) => step.resource === "insights")?.status).toBe("success");
	expect(await readSnapshot(db, snap.account_id, "insights")).toMatchObject({
		fetched_at: now,
		alerts_incomplete: false,
	});
});

it("does not block Insights when optional security alerts are unavailable", async () => {
	const env = await setup();
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) =>
			String(init?.body).includes("vulnerabilityAlerts")
				? Response.json({}, { status: 403 })
				: base(url, init),
		),
	);
	const run = await drive(env);
	expect(run?.steps.find((step) => step.resource === "alerts")?.status).toBe("unavailable");
	expect(run?.steps.find((step) => step.resource === "insights")?.status).toBe("success");
	expect(await readSnapshot(createDb(env.DB), snap.account_id, "insights")).toMatchObject({
		fetched_at: now,
		alerts_incomplete: true,
	});
});

it("retains prior page data on forbidden or limited collection and keeps other pages independent", async () => {
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	for (const limited of [false, true]) {
		const env = await setup();
		const db = createDb(env.DB);
		const old = {
			fetched_at: "2025-01-01T00:00:00.000Z",
			truncated: false,
			forbidden: false,
			views: { count: 9 },
		};
		await db.batch(
			await replaceSnapshotStmts(
				db,
				snap.account_id,
				"repo:nocoo/app:traffic",
				old,
				old.fetched_at,
			),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (url.includes("/traffic/"))
					return limited
						? Response.json({
								count: 1,
								uniques: 1,
								views: [{ timestamp: "x".repeat(1_800_000), count: 1, uniques: 1 }],
							})
						: Response.json({ message: "private permission detail" }, { status: 403 });
				return base(url, init);
			}),
		);
		const run = await drive(env);
		expect(run?.steps.find((s) => s.resource === "repo:nocoo/app:traffic")?.status).toBe(
			limited ? "failed" : "unavailable",
		);
		expect(await readSnapshot(createDb(env.DB), snap.account_id, "repo:nocoo/app:traffic")).toEqual(
			old,
		);
		expect(run?.steps.find((s) => s.resource === "repo:nocoo/app:contributors")?.status).toBe(
			"success",
		);
		expect(run?.steps.find((s) => s.kind === "commit")?.status).toBe("success");
		expect(JSON.stringify(run)).not.toContain("private permission detail");
	}
});

it("fences ordinary snapshot writes when a page finishes after cancellation", async () => {
	const env = await setup();
	const db = createDb(env.DB);
	const found = await getRun(db, snap.account_id, "r1");
	if (!found) throw new Error("fixture");
	found.run.cursor = found.run.steps.findIndex((s) => s.resource === "notifications");
	await db
		.prepare("UPDATE factory_runs SET payload=? WHERE id='r1'")
		.bind(JSON.stringify(found.run))
		.run();
	let release: (r: Response) => void = () => {};
	vi.stubGlobal(
		"fetch",
		vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					release = resolve;
				}),
		),
	);
	const running = executeRunPage(env, "r1", () => now);
	await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
	const { controlRun } = await import("./db/factory-runs");
	await controlRun(createDb(env.DB), snap.account_id, "r1", "cancel", now);
	release(Response.json([]));
	expect(await running).toBeNull();
	expect(await readSnapshot(createDb(env.DB), snap.account_id, "notifications")).toBeNull();
});

it("resumes a failed site-list chunk without advancing its cursor or duplicating earlier records", async () => {
	const env = await setup();
	const db = createDb(env.DB);
	const found = await getRun(db, snap.account_id, "r1");
	if (!found) throw new Error("fixture");
	found.run.siteRepos = Array.from({ length: 11 }, (_, index) => `org/repo${index}`);
	found.run.cursor = found.run.steps.findIndex((step) => step.resource === "issues");
	await db
		.prepare("UPDATE factory_runs SET payload=? WHERE id='r1'")
		.bind(JSON.stringify(found.run))
		.run();
	const previous = {
		truncated: false,
		fetched_at: "2025-01-01",
		issues: [{ title: "last good result" }],
	};
	await db.batch(
		await replaceSnapshotStmts(db, snap.account_id, "issues", previous, previous.fetched_at),
	);
	let calls = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, init) => {
			calls++;
			if (calls === 2) return Response.json({}, { status: 502 });
			const query = String(JSON.parse(String(init?.body)).variables.q);
			const names = query
				.split(" ")
				.filter((part) => part.startsWith("repo:"))
				.map((part) => part.slice(5));
			return Response.json({
				data: {
					search: {
						issueCount: names.length,
						pageInfo: { hasNextPage: false },
						nodes: names.map((name) => ({
							__typename: "Issue",
							number: 1,
							title: name,
							repository: { nameWithOwner: name },
						})),
					},
				},
			});
		}),
	);
	await executeRunPage(env, "r1", () => now);
	expect(await readSnapshot(createDb(env.DB), snap.account_id, "issues")).toEqual(previous);
	await executeRunPage(env, "r1", () => now);
	const failed = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	if (!failed) throw new Error("fixture");
	expect(failed.steps[failed.cursor]).toMatchObject({
		snapshotCursor: 10,
		status: "pending",
		error: "github_error",
	});
	expect(await readSnapshot(createDb(env.DB), snap.account_id, "issues")).toEqual(previous);
	await executeRunPage(env, "r1", () => failed.nextAttemptAt);
	expect(await readSnapshot(createDb(env.DB), snap.account_id, "issues")).toEqual(previous);
	const saved = await readSnapshot(createDb(env.DB), snap.account_id, "issues", "r1");
	if (!saved) throw new Error("fixture");
	expect(saved.issues).toHaveLength(11);
	expect(
		new Set((saved.issues as { name_with_owner: string }[]).map((issue) => issue.name_with_owner))
			.size,
	).toBe(11);
	expect(calls).toBe(3);
});

it.each([
	["issues", "http"],
	["prs", "http"],
	["issues", "graphql"],
	["prs", "graphql"],
])("fails %s %s access loss across durable site-list chunks", async (resource, transport) => {
	const env = await setup();
	const db = createDb(env.DB);
	const found = await getRun(db, snap.account_id, "r1");
	if (!found) throw new Error("fixture");
	found.run.siteRepos = ["nocoo/app", ...Array.from({ length: 10 }, (_, i) => `zz/repo${i}`)];
	await db
		.prepare("UPDATE factory_runs SET payload=? WHERE id='r1'")
		.bind(JSON.stringify(found.run))
		.run();
	const old = {
		truncated: false,
		fetched_at: "2025-01-01T00:00:00.000Z",
		[resource === "prs" ? "pull_requests" : "issues"]: [],
	};
	await db.batch(await replaceSnapshotStmts(db, snap.account_id, resource, old, old.fetched_at));
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) =>
			String(init?.body).includes(`is:${resource === "prs" ? "pr" : "issue"}`) &&
			String(init?.body).includes("repo:zz/repo9")
				? transport === "http"
					? Response.json({ message: "Resource not accessible by integration" }, { status: 403 })
					: Response.json({
							data: { search: null },
							errors: [{ type: "FORBIDDEN", path: ["search"] }],
						})
				: base(url, init),
		),
	);
	for (let i = 0; i < 20; i++) {
		await executeRunPage(env, "r1", () => now);
		const saved = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
		if (saved?.steps.find((step) => step.resource === resource)?.snapshotCursor === 10) break;
	}
	expect(
		(await getRun(db, snap.account_id, "r1"))?.run.steps.find((step) => step.resource === resource),
	).toMatchObject({
		status: "running",
		snapshotCursor: 10,
	});
	const run = await drive(env);
	expect(run?.steps.find((step) => step.resource === resource)).toMatchObject({
		status: "failed",
		error: "snapshot_incomplete",
		snapshotCursor: 10,
	});
	expect(run?.status).toBe("partial");
	expect(await publishedFactory(db, snap.account_id)).toMatchObject({
		runId: "r1",
		status: "partial",
	});
	expect((await listRuns(db, snap.account_id))[0]?.counts.failed).toBeGreaterThan(0);
	expect(await readSnapshot(db, snap.account_id, resource)).toEqual(old);
});

it("loads accepted evidence across runs and copies pinned data into the new publication", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	await drive(env);
	const db = createDb(env.DB);
	await db
		.prepare(
			"UPDATE factory_repo_versions SET payload=json_set(payload,'$.manifests',json(?)) WHERE account_id=?",
		)
		.bind(
			JSON.stringify([
				{
					name: "known-workspace",
					version: "1",
					path: "packages/known/package.json",
					url: "saved",
				},
			]),
			snap.account_id,
		)
		.run();
	await db
		.prepare(
			"UPDATE factory_resources SET payload=json_set(payload,'$.manifests',json('[]'),'$.items',json(?)) WHERE run_id='r1' AND stream='dependencies'",
		)
		.bind(
			JSON.stringify([
				{
					id: "self",
					title: "known-workspace",
					path: "package.json#dependencies",
					url: "saved",
					at: "",
					createdAt: "",
					author: "",
					closedAt: null,
					mergedAt: null,
					state: "declared",
				},
			]),
		)
		.run();
	const later = new Date(Date.parse(now) + 3600000).toISOString();
	const run = makeRun(
		"r2",
		snap.account_id,
		"nocoo",
		"k2",
		"refresh",
		snap.repos,
		later,
		[],
		[],
		{ scope: "selected" },
		"quick",
	);
	await startRun(createDb(env.DB), run);
	for (let i = 0; i < run.steps.length; i++) await executeRunPage(env, "r2", () => later);
	const publication = await publishedFactory(createDb(env.DB), snap.account_id);
	expect(publication?.repos[0]?.observation?.version).toBe("r2");
	expect(publication?.repos[0]?.coverage.commits.strategy).toBe("reused");
	expect(publication?.repos[0]?.coverage.dependencies.strategy).toBe("reused");
	expect(publication?.repos[0]?.dependencies).toEqual([]);
	expect(publication?.repos[0]?.manifests).toMatchObject([{ name: "known-workspace" }]);
	expect((await getRun(createDb(env.DB), snap.account_id, "r2"))?.run.depth).toBe("quick");
	expect((await getRun(createDb(env.DB), snap.account_id, "r2"))?.run.requests).toBeLessThan(
		(await getRun(createDb(env.DB), snap.account_id, "r1"))?.run.requests ?? 0,
	);
});
