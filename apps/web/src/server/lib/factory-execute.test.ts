import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rawRepo } from "../../../../../tests/fixtures/factory";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun, RUN_LEASE_MS, type RunSelection } from "../../lib/factory-run";
import type { Env } from "../env";
import { createApp } from "../index";
import { createDb } from "./db/d1";
import { controlRun, getRun, publishedFactory, startRun } from "./db/factory-runs";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { consumeFactory } from "./factory-dispatch";
import { executeRunPage } from "./factory-execute";
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
			if (url.includes("/dependabot/alerts") && new URL(url).searchParams.has("page"))
				return Response.json({ message: "Numeric pagination is unsupported" }, { status: 400 });
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
it("daily starred refresh publishes all default page sources without requiring old global lists", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] }, true);
	const run = await drive(env);
	expect(run?.status).toBe("completed");
	expect(run?.steps).toHaveLength(22);
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
	).toBe(false);
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
	for (let i = 0; i < 20; i++) {
		const found = await getRun(createDb(env.DB), snap.account_id, "r1");
		if (found?.run.steps[found.run.cursor]?.kind === "metadata") return;
		await executeRunPage(env, "r1", () => now);
	}
	throw new Error("metadata step not reached");
}

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
		await executeRunPage(env, "r1", () => now);
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
	await executeRunPage(env, "r1", () => now);
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
	await beforeMetadata(env);
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

it("refreshes all site pages through the durable run, including derived insights", async () => {
	const env = await setup();
	const db = createDb(env.DB);
	await db.prepare("UPDATE accounts SET is_active=1").run();
	await db.batch(
		replaceSnapshotStmts(
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
		await db.batch(replaceSnapshotStmts(db, snap.account_id, kind, payload, old.fetched_at));
	const base = vi.mocked(fetch).getMockImplementation();
	if (!base) throw new Error("fixture");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) =>
			String(init?.body).includes("search(query")
				? Response.json({}, { status: 403 })
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
		fetched_at: now,
	});
});

it("updates Insights independently of notifications and clears an old incomplete-alert warning", async () => {
	const env = await setup();
	const db = createDb(env.DB);
	await db.batch(
		replaceSnapshotStmts(
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
	expect(run?.steps.find((step) => step.resource === "notifications")?.status).toBe("failed");
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
	expect(run?.steps.find((step) => step.resource === "alerts")?.status).toBe("failed");
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

it("loads accepted evidence across runs and copies pinned data into the new publication", async () => {
	const env = await setup("refresh", { scope: "selected", repos: ["nocoo/app"] });
	await drive(env);
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
	expect((await getRun(createDb(env.DB), snap.account_id, "r2"))?.run.depth).toBe("quick");
	expect((await getRun(createDb(env.DB), snap.account_id, "r2"))?.run.requests).toBeLessThan(
		(await getRun(createDb(env.DB), snap.account_id, "r1"))?.run.requests ?? 0,
	);
});
