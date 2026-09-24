import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rawRepo } from "../../../tests/fixtures/factory";
import { factoryFixture } from "../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../tests/fixtures/sqlite";
import { makeRun, type RunSelection } from "../../lib/factory-run";
import type { Env } from "../env";
import { createDb } from "./db/d1";
import { controlRun, getRun, publishedFactory, startRun } from "./db/factory-runs";
import { readDay, upsertDayStmt } from "./db/snapshot-days";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { executeRunPage } from "./factory-execute";
import { encryptToken, parseKeyBytes } from "./token-crypto";

const snap = factoryFixture();
const now = snap.fetched_at;
async function setup(
	mode: "refresh" | "catalog" = "refresh",
	selection: RunSelection = { scope: "all" },
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
	await db.batch(replaceSnapshotStmts(db, snap.account_id, "factory", { ...snap }, now));
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
	);
	await startRun(db, run);
	return env;
}
beforeEach(() =>
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			const q = String(init?.body);
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
afterEach(() => vi.unstubAllGlobals());
it("publishes only a complete committed repository set and survives every-page restarts", async () => {
	const env = await setup();
	await executeRunPage(env, "r1", () => now);
	expect((await publishedFactory(createDb(env.DB), snap.account_id))?.runId).toBe(snap.runId);
	await drive(env);
	expect((await getRun(createDb(env.DB), snap.account_id, "r1"))?.run.status).toBe("partial"); // contribution unavailable
	const published = await publishedFactory(createDb(env.DB), snap.account_id);
	expect(published?.runId).toBe("r1");
	expect(published?.repos[0]?.observation?.version).toBe("r1");
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
		replaceSnapshotStmts(
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
		digest: { marker: "original digest" },
		"repo:org/other:details": { description: "Retain other repository" },
	};
	for (const [kind, payload] of Object.entries(preserved))
		await db.batch(
			replaceSnapshotStmts(db, snap.account_id, kind, { ...payload, fetched_at: now }, now),
		);
	const originals = new Map(
		await Promise.all(
			Object.keys(preserved).map(
				async (kind) => [kind, await readSnapshot(db, snap.account_id, kind)] as const,
			),
		),
	);
	const daily = { stars: 3, forks: 1, open_issues: 2, repos: 2, by_repo: [] };
	await db.batch([upsertDayStmt(db, snap.account_id, now.slice(0, 10), daily)]);
	const later = new Date(Date.parse(now) + 30_000).toISOString();
	const run = await drive(env, later);
	expect(run?.steps).toHaveLength(20);
	expect(run?.status).toBe("completed");
	for (const [kind, payload] of originals)
		expect(await readSnapshot(db, snap.account_id, kind)).toEqual(payload);
	expect(await readDay(db, snap.account_id, now.slice(0, 10))).toEqual(daily);
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

async function reachAssessment() {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	const db = createDb(env.DB);
	env.FACTORY_QUEUE = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Queue;
	for (const kind of ["summary", "judgment"])
		await db
			.prepare(
				"INSERT INTO ai_settings VALUES(?, 'encrypted',1,'fake','https://ai.example','openai','apiKey',?)",
			)
			.bind(kind, now)
			.run();
	for (let i = 0; i < 50; i++) {
		const found = await getRun(db, snap.account_id, "r1");
		if (found?.run.steps[found.run.cursor]?.kind === "assessment") return { env, db };
		await executeRunPage(env, "r1", () => now);
	}
	throw new Error("AI checkpoint missing");
}

it("waits for the version-bound AI job through judgment and summary without new upstream calls", async () => {
	const { env, db } = await reachAssessment();
	const calls = vi.mocked(fetch).mock.calls.length;
	Reflect.deleteProperty(env, "TOKEN_ENCRYPTION_KEY_V1");
	const firstPoll = await executeRunPage(env, "r1", () => now);
	expect(firstPoll).toBe(new Date(Date.parse(now) + 5000).toISOString());
	let run = (await getRun(db, snap.account_id, "r1"))?.run;
	expect(run?.status).toBe("running");
	expect(run?.steps[run.cursor]).toMatchObject({
		kind: "assessment",
		status: "running",
		assessmentStage: "judgment",
	});
	expect((await publishedFactory(db, snap.account_id))?.runId).toBe(snap.runId);
	await db.prepare("UPDATE ai_reviews SET stage='summary'").run();
	const summaryAt = firstPoll as string;
	const next = await executeRunPage(env, "r1", () => summaryAt);
	run = (await getRun(db, snap.account_id, "r1"))?.run;
	expect(run?.steps[run.cursor]).toMatchObject({ assessmentStage: "summary", status: "running" });
	await db.prepare("UPDATE ai_reviews SET stage='complete',report_version=source_version").run();
	run = await drive(env, next as string);
	expect(run?.status).toBe("completed");
	expect(run?.steps.find((step) => step.kind === "assessment")).toMatchObject({
		status: "success",
		durationMs: 10000,
	});
	expect((await publishedFactory(db, snap.account_id))?.runId).toBe("r1");
	expect(fetch).toHaveBeenCalledTimes(calls);
	expect(env.FACTORY_QUEUE.send).toHaveBeenCalledTimes(1);
});

it("respects AI retry deadlines and retains collected data when analysis fails", async () => {
	const { env, db } = await reachAssessment();
	const retryAt = new Date(Date.parse(now) + 60000).toISOString();
	await db
		.prepare("UPDATE ai_reviews SET error='ai_error',attempts=2,next_at=?,report_version='old'")
		.bind(retryAt)
		.run();
	expect(await executeRunPage(env, "r1", () => now)).toBe(retryAt);
	expect(await executeRunPage(env, "r1", () => now)).toBeNull();
	const previous = await db.prepare("SELECT * FROM factory_repo_state").all();
	await db.prepare("UPDATE ai_reviews SET stage='failed'").run();
	const run = await drive(env, retryAt);
	expect(run?.status).toBe("partial");
	expect(run?.steps.find((step) => step.kind === "assessment")).toMatchObject({
		status: "failed",
		error: "ai_error",
		attempts: 2,
	});
	expect(await db.prepare("SELECT * FROM factory_repo_state").all()).toEqual(previous);
	expect((await publishedFactory(db, snap.account_id))?.repos[0]?.observation?.version).toBe("r1");
	expect(await db.prepare("SELECT report_version FROM ai_reviews").first()).toEqual({
		report_version: "old",
	});
});

it("does not treat a different source version's AI report as this refresh's analysis", async () => {
	const { env, db } = await reachAssessment();
	await db.prepare("UPDATE ai_reviews SET source_version='other',stage='complete'").run();
	const run = await drive(env);
	expect(run?.steps.find((step) => step.kind === "assessment")).toMatchObject({
		status: "skipped",
		error: "ai_source_missing",
	});
	expect(run?.status).toBe("partial");
});
it.each(["pause", "cancel"] as const)(
	"does not extend repository cooldown when AI progress is controlled with %s",
	async (action) => {
		const { env, db } = await reachAssessment();
		await executeRunPage(env, "r1", () => now);
		const previous = await db.prepare("SELECT * FROM factory_repo_state").all();
		const later = new Date(Date.parse(now) + 5000).toISOString();
		await controlRun(db, snap.account_id, "r1", action, later);
		expect(await db.prepare("SELECT * FROM factory_repo_state").all()).toEqual(previous);
		expect(await executeRunPage(env, "r1", () => later)).toBeNull();
		if (action === "pause") {
			await controlRun(db, snap.account_id, "r1", "resume", later);
			await db.prepare("UPDATE ai_reviews SET stage='complete'").run();
			expect((await drive(env, later))?.status).toBe("completed");
		}
	},
);
it.each([
	["ai_not_configured", "skipped", "completed", "ai_not_configured"],
	["factory_capacity", "failed", "partial", "ai_capacity"],
] as const)(
	"isolates terminal AI %s from repository publication",
	async (error, status, outcome, code) => {
		const { env, db } = await reachAssessment();
		await db.prepare("UPDATE ai_reviews SET stage='failed',error=?").bind(error).run();
		const run = await drive(env);
		expect(run?.status).toBe(outcome);
		expect(run?.steps.find((step) => step.kind === "assessment")).toMatchObject({
			status,
			error: code,
		});
		expect((await publishedFactory(db, snap.account_id))?.runId).toBe("r1");
	},
);
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
	expect(run?.steps.filter((s) => s.status === "skipped")).toHaveLength(9);
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
	const { ready } = await import("../../../tests/fixtures/factory");
	const { memoryStore, github } = await import("../../../tests/fixtures/factory");
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
		await db.batch(replaceSnapshotStmts(db, snap.account_id, kind, { ...data }, now));
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
			found.run.cursor = 9;
			await createDb(env.DB)
				.prepare("UPDATE factory_runs SET payload=? WHERE id=?")
				.bind(JSON.stringify(found.run), "r1")
				.run();
		}
		if (mode === "rate") {
			for (let i = 0; i < 3; i++) await executeRunPage(env, "r1", () => now);
			expect((await getRun(createDb(env.DB), snap.account_id, "r1"))?.run.nextAttemptAt).toBe(
				"2099-01-01T00:00:00.000Z",
			);
		} else {
			const run = await drive(env);
			expect(run?.status).toBe(
				mode === "inventory"
					? "failed"
					: mode === "capacity"
						? "paused"
						: mode === "contributions"
							? "completed"
							: "partial",
			);
			if (mode === "coverage")
				expect(run?.steps.find((s) => s.kind === "alerts")?.error).toBe("coverage_unavailable");
			if (mode === "contributions")
				expect(
					(await publishedFactory(createDb(env.DB), snap.account_id))?.contribution?.total,
				).toBe(1);
		}
	}
});

it("rechecks repository cooldown at execution after a competing run commits during planning", async () => {
	const env = await setup();
	await executeRunPage(env, "r1", () => now);
	await createDb(env.DB)
		.prepare("INSERT INTO factory_repo_state(account_id,repo,payload) VALUES(?,?,?)")
		.bind(
			snap.account_id,
			"nocoo/app",
			JSON.stringify({ repo: "nocoo/app", nextAllowedAt: "2999-01-01T00:00:00.000Z" }),
		)
		.run();
	const calls = vi.mocked(fetch).mock.calls.length;
	await executeRunPage(env, "r1", () => now);
	expect(fetch).toHaveBeenCalledTimes(calls);
	const run = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	expect(run?.steps.filter((s) => s.status === "skipped")).toHaveLength(10);
});

it("uses server time for persisted heartbeat when no clock is injected", async () => {
	const env = await setup();
	const before = Date.now();
	await executeRunPage(env, "r1");
	const run = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	expect(Date.parse(run?.updatedAt ?? "")).toBeGreaterThanOrEqual(before);
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
		if (sql.startsWith("UPDATE factory_runs SET payload=? WHERE id=?"))
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
	await db.batch(replaceSnapshotStmts(db, snap.account_id, "factory", old, now));
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
	await executeRunPage(env, "r1", () => now);
	await executeRunPage(env, "r1", () => now);
	await controlRun(createDb(env.DB), snap.account_id, "r1", "pause", now);
	expect((await repoStates(createDb(env.DB), snap.account_id))[0]).toMatchObject({
		attemptRunId: "r1",
		attemptStatus: "pause",
		nextAllowedAt: "2026-09-15T22:15:00.000Z",
	});
	await controlRun(createDb(env.DB), snap.account_id, "r1", "resume", now);
	expect((await drive(env))?.status).toBe("partial");
});
it("pauses at total factory capacity without replacing the published snapshot", async () => {
	const env = await setup();
	await createDb(env.DB).prepare("UPDATE factory_budget SET bytes=?").bind(255_000_000).run();
	await executeRunPage(env, "r1", () => now);
	const run = (await getRun(createDb(env.DB), snap.account_id, "r1"))?.run;
	expect(run?.status).toBe("paused");
	expect(run?.steps[0]).toMatchObject({ error: "factory_capacity", pages: 0, finishedAt: null });
	expect((await publishedFactory(createDb(env.DB), snap.account_id))?.runId).toBe(snap.runId);
});

it("does not shorten an existing repository cooldown on repeated pause/cancel controls", async () => {
	const env = await setup();
	const { controlRun, repoStates } = await import("./db/factory-runs");
	await executeRunPage(env, "r1", () => now);
	await executeRunPage(env, "r1", () => now);
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

it("refreshes all site pages through the durable run, including derived insights and digest", async () => {
	const env = await setup();
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
		"digest",
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
			replaceSnapshotStmts(db, snap.account_id, "repo:nocoo/app:traffic", old, old.fetched_at),
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
		expect(run?.steps.find((s) => s.resource === "repo:nocoo/app:traffic")?.status).toBe("failed");
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
		replaceSnapshotStmts(db, snap.account_id, "issues", previous, previous.fetched_at),
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
	const saved = await readSnapshot(createDb(env.DB), snap.account_id, "issues");
	if (!saved) throw new Error("fixture");
	expect(saved.issues).toHaveLength(11);
	expect(
		new Set((saved.issues as { name_with_owner: string }[]).map((issue) => issue.name_with_owner))
			.size,
	).toBe(11);
	expect(calls).toBe(3);
});
