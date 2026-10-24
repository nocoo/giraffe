import { expect, it } from "vitest";
import { unsupportedWorkflowJobs } from "../../../../../tests/fixtures/dependency-workflow";
import { github, memoryStore, ready } from "../../../../../tests/fixtures/factory";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { emptyDay, emptyMetrics, factoryWindow } from "../../lib/factory";
import { makeRun } from "../../lib/factory-run";
import { FACTORY_STREAMS, type FactorySnapshot } from "../../lib/factory-types";
import { beginCatalog, planCatalog } from "./catalog-history";
import { contentVersion, observationVersion } from "./content-version";
import { createDb } from "./db/d1";
import {
	claimRun,
	controlRun,
	publishedFactory,
	repoStates,
	saveRun,
	startRun,
} from "./db/factory-runs";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { stepFactory } from "./factory-collect";
import {
	boundedJson,
	currentRepo,
	publicationWrites,
	repositoryWrites,
	restoreLegacyRepo,
	snapshotWrites,
} from "./factory-publish";
import { readFactoryResource } from "./machine-observations";

const snap = factoryFixture();
const now = snap.fetched_at;
async function setup() {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?,?,?,?,?)",
		)
		.bind(snap.account_id, "nocoo", "encrypted", "fake", now, now)
		.run();
	const run = makeRun("r1", snap.account_id, "nocoo", "key", "catalog", [], now);
	await startRun(db, run);
	const lease = await claimRun(db, "r1", now);
	if (!lease) throw new Error("fixture");
	const repo = structuredClone(snap.repos[0]);
	if (!repo) throw new Error("fixture");
	return { raw, db, lease, repo };
}
async function completeCatalog(
	db: ReturnType<typeof createDb>,
	lease: NonNullable<Awaited<ReturnType<typeof claimRun>>>,
) {
	const repos = lease.run.checkpoint?.repos ?? [];
	const plan = await planCatalog(
		await beginCatalog(db, snap.account_id),
		{
			truncated: false,
			repos: repos.map((repo) => ({
				name_with_owner: repo.name,
				is_archived: repo.is_archived ?? false,
				is_fork: repo.is_fork ?? false,
				is_private: repo.private,
			})),
		},
		Object.fromEntries(repos.map((repo) => [repo.name.toLowerCase(), repo.id])),
		"nocoo",
		github(() => Response.json({ message: "Not Found" }, { status: 404 })),
		"fixture",
		now,
		{ kind: "factory", runId: lease.run.id },
	);
	const step = lease.run.steps.find((step) => step.resource === "repos");
	if (!step) throw new Error("Missing catalog fixture step");
	step.status = "success";
	await db
		.prepare(
			"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,'','catalog-plan',?)",
		)
		.bind(lease.run.id, JSON.stringify(plan))
		.run();
}

async function historyFixture(previousDays: number | null = 90, depth: "quick" | "deep" = "quick") {
	const { db, lease, repo } = await setup();
	lease.run.mode = "refresh";
	lease.run.depth = depth;
	lease.run.window = factoryWindow(now, depth === "quick" ? 30 : 90);
	for (const stream of FACTORY_STREAMS) repo.coverage[stream].status = "complete";
	repo.metrics = emptyMetrics();
	repo.observation = {
		version: "previous",
		source: "run",
		refreshedAt: now,
		window: factoryWindow(now, previousDays ?? 30),
	};
	if (previousDays !== null) {
		for (let i = 0; i < previousDays; i++) {
			const date = new Date(Date.parse(now.slice(0, 10)) - i * 86_400_000)
				.toISOString()
				.slice(0, 10);
			repo.metrics.days[date] = { ...emptyDay(), commits: 2, prMerged: 1 };
		}
		repo.metrics.commits = previousDays * 2;
		repo.metrics.prMerged = previousDays;
		await db.batch(await repositoryWrites(db, lease, now, repo, repo.name, null));
	}
	const base: FactorySnapshot = {
		...snap,
		runId: "previous",
		window: repo.observation.window,
		repos: previousDays === null ? structuredClone(snap.repos) : [structuredClone(repo)],
	};
	await db.batch(await snapshotWrites(db, lease, now, "factory:v:previous", base));
	await db
		.prepare("UPDATE factory_state SET published_id='previous' WHERE account_id=?")
		.bind(snap.account_id)
		.run();
	const fresh = structuredClone(repo);
	fresh.observation = { ...repo.observation, version: lease.run.id, window: lease.run.window };
	fresh.metrics = emptyMetrics();
	fresh.metrics.days[now.slice(0, 10)] = { ...emptyDay(), commits: 7, prMerged: 3 };
	fresh.metrics.commits = 7;
	fresh.metrics.prMerged = 3;
	return { db, lease, repo, fresh, base };
}

it.each([90, 120])(
	"retains and caps %i published dates outside a successful quick window",
	async (previousDays) => {
		const { db, lease, repo, fresh } = await historyFixture(previousDays);
		const before = structuredClone(fresh);
		await db.batch(await repositoryWrites(db, lease, now, fresh, fresh.name, null));
		await db.batch(await publicationWrites(db, lease, now));
		const published = await publishedFactory(db, snap.account_id);
		const saved = await currentRepo(db, snap.account_id, fresh.name);
		expect(saved?.observation?.window).toEqual(factoryWindow(now, 90));
		expect(published?.window).toEqual(factoryWindow(now, 90));
		expect(published?.repos[0]).toEqual({
			...saved,
			observation: { ...saved?.observation, publishedAt: now },
		});
		expect(saved?.metrics.days).toEqual({
			...Object.fromEntries(
				Object.entries(repo.metrics.days).filter(
					([date]) =>
						date >= factoryWindow(now, 90).since.slice(0, 10) &&
						date < lease.run.window.since.slice(0, 10),
				),
			),
			...fresh.metrics.days,
		});
		expect(saved?.metrics).toMatchObject({ commits: 127, prMerged: 63 });
		expect(saved?.metrics.days[lease.run.window.since.slice(0, 10)]).toBeUndefined();
		expect(saved?.coverage.commits.retained).toBeUndefined();
		expect(published?.publication?.mixed).toBe(false);
		expect(fresh).toEqual(before);
		expect(await readSnapshot(db, snap.account_id, "factory:v:previous")).toMatchObject({
			repos: [repo],
		});
	},
);

it.each([null, 45])(
	"does not invent 90-day history from a %s-day baseline",
	async (previousDays) => {
		const { db, lease, fresh } = await historyFixture(previousDays);
		await db.batch(await repositoryWrites(db, lease, now, fresh, fresh.name, null));
		await db.batch(await publicationWrites(db, lease, now));
		const published = await publishedFactory(db, snap.account_id);
		expect(published?.window).toEqual(factoryWindow(now, previousDays ?? 30));
		expect(published?.repos[0]?.observation?.window).toEqual(published?.window);
		expect(published?.repos[0]?.metrics.commits).toBe(previousDays === null ? 7 : 37);
	},
);

it("keeps the actual quick source window after deep history, quick publication and a failed stream", async () => {
	const { db, lease, fresh } = await historyFixture(90);
	const quickWindow = { ...lease.run.window };
	await db
		.prepare("INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,?,'commits',?)")
		.bind(
			lease.run.id,
			fresh.name,
			JSON.stringify({
				runId: lease.run.id,
				items: [],
				ranges: [],
				next: null,
				coverage: fresh.coverage.commits,
			}),
		)
		.run();
	await db.batch(await repositoryWrites(db, lease, now, fresh, fresh.name, null));
	await db.batch(await publicationWrites(db, lease, now));
	expect(
		(await readFactoryResource(db, snap.account_id, fresh.name, "commits")).data,
	).toMatchObject({ ranges: [quickWindow], observation: { window: quickWindow } });
	lease.run.status = "completed";
	expect(await saveRun(db, lease, [], now)).toBe(true);
	const nextAt = "2026-09-16T22:00:00.000Z";
	const run = makeRun(
		"failure",
		snap.account_id,
		"nocoo",
		"failure",
		"refresh",
		[fresh],
		nextAt,
		[],
		[],
		{ scope: "selected", repos: [fresh.name] },
		"quick",
	);
	await startRun(db, run);
	const next = await claimRun(db, run.id, nextAt);
	if (!next) throw new Error("fixture");
	fresh.observation = { version: run.id, source: "run", refreshedAt: nextAt, window: run.window };
	fresh.coverage.commits.status = "unavailable";
	await db.batch(await repositoryWrites(db, next, nextAt, fresh, fresh.name, null));
	await db.batch(await publicationWrites(db, next, nextAt));
	const published = await publishedFactory(db, snap.account_id);
	expect(published?.repos[0]?.metrics.commits).toBe(127);
	expect(published?.repos[0]?.observation?.window).toEqual({
		...factoryWindow(now, 90),
		until: nextAt,
	});
	expect(published?.window).toEqual({ ...factoryWindow(now, 90), until: nextAt });
	expect(
		Object.entries(published?.repos[0]?.metrics.days ?? {})
			.filter(([date]) => date >= String(published?.window.since.slice(0, 10)))
			.reduce((sum, [, day]) => sum + day.commits, 0),
	).toBe(127);
	expect(published?.repos[0]?.coverage.commits).toMatchObject({
		retained: true,
		observation: { version: lease.run.id, window: quickWindow },
		completeWindows: [factoryWindow(now, 90)],
	});
	expect(
		(await readFactoryResource(db, snap.account_id, fresh.name, "commits")).data,
	).toMatchObject({ ranges: [quickWindow], observation: { window: quickWindow } });
});

it("keeps retained-stream provenance and totals separate from successful daily-history merging", async () => {
	const { db, lease, repo, fresh } = await historyFixture(120);
	await db
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) SELECT 'previous',account_id,'previous','completed',payload,next_at,created_at,updated_at FROM factory_runs WHERE id='r1'",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES('previous',?,'commits',?)",
		)
		.bind(
			repo.name,
			JSON.stringify({
				runId: "previous",
				items: [],
				ranges: [],
				next: null,
				coverage: repo.coverage.commits,
			}),
		)
		.run();
	fresh.coverage.commits.status = "unavailable";
	await db.batch(await repositoryWrites(db, lease, now, fresh, fresh.name, null));
	await db.batch(await publicationWrites(db, lease, now));
	const published = await publishedFactory(db, snap.account_id);
	expect(published?.window).toEqual(repo.observation?.window);
	expect(published?.publication?.mixed).toBe(true);
	expect(published?.repos[0]).toMatchObject({
		observation: { window: repo.observation?.window },
		coverage: { commits: { retained: true, observation: repo.observation } },
		metrics: { commits: 240, prMerged: 63 },
	});
});

it("replaces the entire deep window and retains that display span on the next quick publish", async () => {
	const { db, lease, fresh } = await historyFixture(120, "deep");
	await db.batch(await repositoryWrites(db, lease, now, fresh, fresh.name, null));
	await db.batch(await publicationWrites(db, lease, now));
	expect((await publishedFactory(db, snap.account_id))?.repos[0]?.metrics).toEqual(fresh.metrics);
	lease.run.status = "completed";
	expect(await saveRun(db, lease, [], now)).toBe(true);
	const nextAt = "2026-09-16T22:00:00.000Z";
	const run = makeRun(
		"next",
		snap.account_id,
		"nocoo",
		"next",
		"refresh",
		[fresh],
		nextAt,
		[],
		[],
		{ scope: "selected", repos: [fresh.name] },
		"quick",
	);
	await startRun(db, run);
	const next = await claimRun(db, run.id, nextAt);
	if (!next) throw new Error("fixture");
	fresh.observation = { version: run.id, source: "run", refreshedAt: nextAt, window: run.window };
	await db.batch(await repositoryWrites(db, next, nextAt, fresh, fresh.name, null));
	await db.batch(await publicationWrites(db, next, nextAt));
	const published = await publishedFactory(db, snap.account_id);
	expect(published?.window).toEqual(factoryWindow(nextAt, 90));
	expect(published?.repos[0]?.metrics).toEqual(fresh.metrics);
	expect(run.window).toEqual(factoryWindow(nextAt, 30));
});

it.each([false, true])(
	"preserves contribution history and provenance (recollected: %s)",
	async (recollected) => {
		const { db, lease, base } = await historyFixture(null);
		base.repos = [];
		base.window = factoryWindow(now, 120);
		const oldDay = { date: factoryWindow(now, 90).since.slice(0, 10), count: 4, observedAt: "old" };
		base.contribution = {
			days: [
				{ date: base.window.since.slice(0, 10), count: 1 },
				oldDay,
				{ date: now.slice(0, 10), count: 100 },
			],
			total: 105,
			restricted: 0,
			fetchedAt: "old",
		};
		base.contributionObservation = { version: "previous", window: base.window, fetchedAt: "old" };
		base.contributionStatus = "complete";
		await db.batch(await snapshotWrites(db, lease, now, "factory:v:previous", base));
		if (recollected) {
			lease.run.checkpoint = {
				...snap,
				contributionStatus: "complete",
				contribution: {
					days: [{ date: now.slice(0, 10), count: 9 }],
					total: 9,
					restricted: 0,
					fetchedAt: now,
				},
			};
			lease.run.steps.push({
				kind: "contributions",
				repo: null,
				status: "success",
				attempts: 1,
				startedAt: now,
				finishedAt: now,
				durationMs: 1,
				pages: 1,
				error: null,
			});
		}
		await db.batch(await publicationWrites(db, lease, now));
		const published = await publishedFactory(db, snap.account_id);
		expect(published?.contribution).toEqual(
			recollected
				? {
						...lease.run.checkpoint?.contribution,
						total: 13,
						days: [
							{ ...oldDay, fetchedAt: "old" },
							{ date: now.slice(0, 10), count: 9, fetchedAt: now, observedAt: now },
						],
					}
				: base.contribution,
		);
		expect(published?.contributionObservation).toEqual(
			recollected
				? { version: lease.run.id, window: factoryWindow(now, 90), fetchedAt: now }
				: base.contributionObservation,
		);
		expect(published?.window).toEqual(recollected ? factoryWindow(now, 90) : base.window);
		expect(published?.publication?.mixed).toBe(!recollected);
	},
);
it("preserves stronger last-known-good coverage and failed-repository metadata in one atomic commit", async () => {
	const { raw, db, lease, repo } = await setup();
	for (const key of FACTORY_STREAMS) repo.coverage[key].status = "complete";
	repo.observation = { version: "r1", refreshedAt: now, window: snap.window, source: "run" };
	await db.batch(await repositoryWrites(db, lease, now, repo, repo.name, null));
	await db
		.prepare("INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES('r1',?,'prs',?)")
		.bind(
			repo.name,
			JSON.stringify({
				runId: "r1",
				items: [],
				ranges: [],
				next: null,
				coverage: repo.coverage.prs,
			}),
		)
		.run();
	expect((await repoStates(db, snap.account_id))[0]).toMatchObject({
		status: "success",
		version: "r1",
		coverage: 7,
	});
	const incomplete = structuredClone(repo);
	incomplete.coverage.prs.status = "unavailable";
	incomplete.metrics.prMerged = 999;
	await db.batch(await repositoryWrites(db, lease, now, incomplete, repo.name, null));
	expect((await currentRepo(db, snap.account_id, repo.name))?.metrics.prMerged).toBe(0);
	expect((await repoStates(db, snap.account_id))[0]).toMatchObject({
		status: "partial",
		error: "coverage_regression_retained",
		refreshedAt: now,
	});
	await db.batch(await repositoryWrites(db, lease, now, null, repo.name, "github_error"));
	expect((await repoStates(db, snap.account_id))[0]).toMatchObject({
		status: "failed",
		version: "r1",
		coverage: 7,
	});
	expect(await restoreLegacyRepo(db, lease, now, repo)).toEqual([]);
	const writes = await repositoryWrites(db, lease, now, repo, repo.name, null);
	await controlRun(createDb(raw), snap.account_id, "r1", "pause", now);
	expect(await saveRun(db, lease, writes, now)).toBe(false);
	expect((await repoStates(createDb(raw), snap.account_id))[0]?.status).toBe("failed");
});

it.each(unsupportedWorkflowJobs)(
	"retains the published repository for unparsed workflow jobs: %s",
	async (text) => {
		const { db, lease, repo } = await setup();
		for (const stream of FACTORY_STREAMS) repo.coverage[stream].status = "complete";
		repo.dependencies = [
			{ name: "actions/checkout", version: "v4", path: ".github/workflows/ci.yml", url: "saved" },
		];
		repo.observation = { version: "r1", refreshedAt: now, window: snap.window, source: "run" };
		await db.batch(await repositoryWrites(db, lease, now, repo, repo.name, null));
		await db
			.prepare(
				"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES('r1',?,'dependencies',?)",
			)
			.bind(
				repo.name,
				JSON.stringify({
					runId: "r1",
					items: [],
					ranges: [],
					next: null,
					coverage: repo.coverage.dependencies,
				}),
			)
			.run();
		const before = await currentRepo(db, snap.account_id, repo.name);
		await db
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) SELECT 'r2',account_id,'r2','completed',payload,next_at,created_at,updated_at FROM factory_runs WHERE id='r1'",
			)
			.run();
		const state = ready("dependencies");
		state.repos = [structuredClone(repo)];
		const candidate = state.repos[0];
		if (!candidate) throw new Error("fixture");
		candidate.observation = {
			...repo.observation,
			version: "r2",
			refreshedAt: "2026-10-21T00:00:00Z",
			window: { since: "2026-07-18T00:00:00.000Z", until: now },
		};
		state.window = candidate.observation.window;
		await stepFactory(
			state,
			github(() => Response.json({ data: { repository: { ci: { text } } } })),
			"test-token",
			memoryStore(),
			now,
		);
		await db.batch(await repositoryWrites(db, lease, now, candidate, repo.name, null));
		expect(await currentRepo(db, snap.account_id, repo.name)).toMatchObject({
			observation: {
				...candidate.observation,
				collectionWindow: candidate.observation.window,
				window: { since: repo.observation.window.since, until: candidate.observation.window.until },
			},
			dependencies: before?.dependencies,
			coverage: { dependencies: { ...before?.coverage.dependencies, retained: true } },
		});
		expect((await repoStates(db, snap.account_id))[0]).toMatchObject({
			version: "r2",
			status: "partial",
			error: "coverage_regression_retained",
		});
	},
);
it("fails closed at storage limits and for missing publication input", async () => {
	const { db, lease } = await setup();
	expect(() => boundedJson("x".repeat(1_800_001))).toThrow("capacity");
	await expect(
		snapshotWrites(db, lease, now, "factory:v:large", { ...snap, owner: "x".repeat(3_100_000) }),
	).rejects.toThrow("capacity");
	await expect(publicationWrites(db, lease, now)).rejects.toMatchObject({
		code: "snapshot_missing",
	});
});

it.each(["factory:v:content", "factory:catalog:content"])(
	"persists the factory recipe with fenced %s publication writes",
	async (kind) => {
		const { raw, db, lease } = await setup();
		await db.batch(await snapshotWrites(db, lease, now, kind, snap));
		const first = await db
			.prepare("SELECT payload,content_meta FROM snapshots WHERE account_id=? AND kind=?")
			.bind(snap.account_id, kind)
			.first<{ payload: string; content_meta: string }>();
		if (!first) throw new Error("missing publication");
		expect(JSON.parse(first.payload)).toEqual(snap);
		expect(JSON.parse(first.content_meta)).toEqual({
			hash: await contentVersion("factory", snap),
			fullVersion: await observationVersion(snap),
			version: snap.runId,
		});
		const writes = await snapshotWrites(db, lease, now, kind, { ...snap, owner: "changed" });
		await controlRun(createDb(raw), snap.account_id, "r1", "pause", now);
		expect(await saveRun(db, lease, writes, now)).toBe(false);
		expect(
			await db
				.prepare("SELECT payload,content_meta FROM snapshots WHERE account_id=? AND kind=?")
				.bind(snap.account_id, kind)
				.first(),
		).toEqual(first);
	},
);

it.each([false, true])(
	"publishes observations without creating or changing cloud AI rows (saved review: %s)",
	async (savedReview) => {
		const { db, lease, repo } = await setup();
		await db
			.prepare(
				"INSERT INTO ai_settings(kind,api_key_ciphertext,key_version,model,base_url,sdk_type,auth_type,updated_at) VALUES('summary','encrypted',1,'fake','https://models.example.test','openai','apiKey','old')",
			)
			.run();
		await db.prepare("INSERT INTO ai_provider_options(kind,enabled) VALUES('summary',1)").run();
		if (savedReview) {
			await db
				.prepare(
					"INSERT INTO ai_reviews(account_id,repo,job_id,source_version,source_at,stage,report,report_version,next_at) VALUES(?,?,'old-job','old-source',?,'summary','{\"saved\":true}','old-source',?)",
				)
				.bind(snap.account_id, repo.name, now, now)
				.run();
			await db
				.prepare(
					"INSERT INTO ai_review_attempts(job_id,stage,attempt,source_version,error,diagnostic,recorded_at) VALUES('old-job','summary',1,'old-source','ai_error','{}',?)",
				)
				.bind(now)
				.run();
		}
		const tables = ["ai_settings", "ai_provider_options", "ai_reviews", "ai_review_attempts"];
		const previous = await Promise.all(
			tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
		);
		repo.observation = {
			version: lease.run.id,
			window: lease.run.window,
			refreshedAt: now,
			source: "run",
		};
		const writes = await repositoryWrites(db, lease, now, repo, repo.name, null);
		expect(await saveRun(db, lease, writes, now)).toBe(true);
		expect((await currentRepo(db, snap.account_id, repo.name))?.observation?.version).toBe(
			lease.run.id,
		);
		expect(
			await Promise.all(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())),
		).toEqual(previous);
	},
);
it("does not overwrite a published global version when updating only the catalog", async () => {
	const { db, lease, repo } = await setup();
	await db.batch(
		await replaceSnapshotStmts(db, snap.account_id, "factory:v:existing", { ...snap }, now),
	);
	await db
		.prepare("UPDATE factory_state SET published_id=? WHERE account_id=?")
		.bind("existing", snap.account_id)
		.run();
	lease.run.checkpoint = { ...snap, repos: [repo] };
	await completeCatalog(db, lease);
	await db.batch(await publicationWrites(db, lease, now));
	expect((await publishedFactory(db, snap.account_id))?.runId).toBe(snap.runId);
});

it("retains identical legacy dependency summaries in subsequent publication writes", async () => {
	const { db, lease, repo } = await setup();
	lease.run.mode = "refresh";
	const dependency = {
		name: "actions/upload-artifact",
		version: "v4",
		path: ".github/workflows/ci.yml",
		url: "saved",
	};
	repo.dependencies = [dependency, { ...dependency }];
	repo.observation = { source: "legacy", version: "old", window: snap.window, refreshedAt: now };
	await db.batch(
		await replaceSnapshotStmts(db, snap.account_id, "factory", { ...snap, repos: [repo] }, now),
	);
	const before = await readSnapshot(db, snap.account_id, "factory");
	await db.batch(await publicationWrites(db, lease, now));
	expect(await readSnapshot(db, snap.account_id, `factory:v:${lease.run.id}`)).toMatchObject({
		repos: [{ dependencies: repo.dependencies, observation: repo.observation }],
	});
	expect(await readSnapshot(db, snap.account_id, "factory")).toEqual(before);
});

it("recovers only matching legacy resource versions and does not invent missing data", async () => {
	const { db, lease, repo } = await setup();
	expect(await restoreLegacyRepo(db, lease, now, repo)).toEqual([]);
	await db.batch([
		...(await replaceSnapshotStmts(
			db,
			snap.account_id,
			"factory",
			{ ...snap, repos: [repo] },
			now,
		)),
		...(await replaceSnapshotStmts(
			db,
			snap.account_id,
			"factory:nocoo/app:commits",
			{ runId: now, items: [], coverage: { ...repo.coverage.commits, status: "partial" } },
			now,
		)),
		...(await replaceSnapshotStmts(
			db,
			snap.account_id,
			"factory:nocoo/app:issues",
			{
				runId: "another",
				items: [],
				coverage: { ...repo.coverage.issues, fetchedAt: "2027-01-01T00:00:00.000Z" },
			},
			now,
		)),
		...(await replaceSnapshotStmts(
			db,
			snap.account_id,
			"factory:nocoo/app:dependencies",
			{
				runId: now,
				items: [{ id: "one", title: "package", url: "https://github.com/nocoo/app", at: now }],
				coverage: { ...repo.coverage.dependencies, status: "complete" },
			},
			now,
		)),
	]);
	await db.batch(await restoreLegacyRepo(db, lease, now, repo));
	const current = await currentRepo(db, snap.account_id, repo.name);
	expect(current?.coverage.commits.status).toBe("partial");
	expect(current?.coverage.issues.status).toBe("pending");
	expect(current?.dependencies).toEqual([
		{ name: "package", version: "", path: "", url: "https://github.com/nocoo/app" },
	]);
	expect(current?.observation?.refreshedAt).toBe(now);
});

it("restores old root and workspace identities separately from actual dependencies", async () => {
	const { db, lease, repo } = await setup();
	await db.batch(
		await replaceSnapshotStmts(db, snap.account_id, "factory", { ...snap, repos: [repo] }, now),
	);
	const declarations = [
		{ name: "own", path: "package.json#name" },
		{ name: "child", path: "packages/child/package.json#name" },
		{ name: "child", path: "package.json#dependencies" },
		{ name: "external", path: "package.json#dependencies" },
	];
	await db.batch(
		await replaceSnapshotStmts(
			db,
			snap.account_id,
			`factory:${repo.name}:dependencies`,
			{
				runId: now,
				items: declarations.map((declaration) => ({
					id: declaration.path + declaration.name,
					title: declaration.name,
					path: declaration.path,
					url: "saved",
					at: "",
					createdAt: "",
					author: "",
				})),
				coverage: { ...repo.coverage.dependencies, status: "complete" },
			},
			now,
		),
	);
	await db.batch(await restoreLegacyRepo(db, lease, now, repo));
	const current = await currentRepo(db, snap.account_id, repo.name);
	expect(current?.dependencies.map((dependency) => dependency.name)).toEqual(["external"]);
	expect(current?.manifests?.map((manifest) => manifest.name)).toEqual(["own", "child"]);
	const row = await db
		.prepare("SELECT payload FROM factory_repo_versions")
		.first<{ payload: string }>();
	expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({
		dependencies: [{ name: "external" }],
		manifests: [{ name: "own" }, { name: "child" }],
	});
});

it.each([
	{ proof: "publication", valid: true },
	{ proof: "archive", valid: true },
	{ proof: "physical-alias", valid: true },
	{ proof: "missing", valid: false },
	{ proof: "wrong-id", valid: false },
	{ proof: "wrong-version", valid: false },
	{ proof: "wrong-source", valid: false },
	{ proof: "wrong-physical-key", valid: false },
	{ proof: "invalid-window", valid: false },
	{ proof: "reversed-window", valid: false },
	{ proof: "missing-window", valid: false },
	{ proof: "archive-metadata-only", valid: false },
	{ proof: "archive-other-account", valid: false },
])("R7 legacy restore requires a positive source binding ($proof)", async ({ proof, valid }) => {
	const { raw, db, lease, repo } = await setup();
	const source = structuredClone(repo);
	const sourceWindow = { since: "2026-09-01T00:00:00.000Z", until: now };
	source.observation = {
		source: "legacy",
		version: now,
		repo: repo.name,
		refreshedAt: now,
		window: sourceWindow,
	};
	if (proof === "wrong-id") source.id = "R_OTHER";
	if (proof === "wrong-version") source.observation.version = "other-version";
	if (proof === "wrong-source") source.observation.source = "run";
	if (proof === "wrong-physical-key") source.observation.repo = "nocoo/other";
	if (proof === "invalid-window") source.observation.window = { ...sourceWindow, since: "invalid" };
	if (proof === "reversed-window")
		source.observation.window = { since: now, until: sourceWindow.since };
	if (proof === "physical-alias") source.name = "nocoo/renamed";
	const serialized = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
	if (proof === "missing-window") delete (serialized.observation as Record<string, unknown>).window;
	if (proof === "archive-metadata-only") delete serialized.observation;
	if (proof === "archive-other-account")
		await raw
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('foreign','foreign','fake','fake',?,?)",
			)
			.bind(now, now)
			.run();
	if (proof.startsWith("archive")) {
		await db
			.prepare(
				"INSERT INTO factory_repo_versions(account_id,repo,version,payload,refreshed_at) VALUES(?,?,?,?,?)",
			)
			.bind(
				proof === "archive-other-account" ? "foreign" : snap.account_id,
				repo.name,
				now,
				JSON.stringify(serialized),
				now,
			)
			.run();
	} else if (proof !== "missing") {
		await db.batch(
			await replaceSnapshotStmts(
				db,
				snap.account_id,
				"factory",
				{ ...snap, repos: [serialized], window: sourceWindow },
				now,
			),
		);
	}
	await db.batch(
		await replaceSnapshotStmts(
			db,
			snap.account_id,
			`factory:${repo.name}:commits`,
			{
				runId: now,
				items: [],
				coverage: { ...repo.coverage.commits, status: "complete", fetchedAt: now },
			},
			now,
		),
	);
	const frozen = await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all();
	const immutable = await raw
		.prepare("SELECT * FROM factory_repo_versions ORDER BY account_id,repo,version")
		.all();
	const writes = await restoreLegacyRepo(db, lease, now, repo);
	expect(writes).toHaveLength(valid ? 2 : 0);
	await db.batch(writes);
	const current = await currentRepo(db, snap.account_id, repo.name);
	if (valid)
		expect(current).toMatchObject({
			id: repo.id,
			observation: {
				source: "legacy",
				version: now,
				repo: repo.name,
				refreshedAt: now,
				window: sourceWindow,
			},
		});
	else expect(current).toBeNull();
	expect(await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(frozen);
	const after = (
		await raw.prepare("SELECT * FROM factory_repo_versions ORDER BY account_id,repo,version").all()
	).results;
	for (const row of immutable.results) expect(after).toContainEqual(row);
});

it("deduplicates renamed repositories by stable GitHub identity at publication", async () => {
	const { db, lease, repo } = await setup();
	await db.batch(await replaceSnapshotStmts(db, snap.account_id, "factory", { ...snap }, now));
	lease.run.mode = "refresh";
	repo.name = "nocoo/renamed";
	repo.observation = { version: "r1", refreshedAt: now, window: snap.window, source: "run" };
	await db.batch(await repositoryWrites(db, lease, now, repo, repo.name, null));
	await db.batch(await publicationWrites(db, lease, now));
	const published = await publishedFactory(db, snap.account_id);
	expect(published?.repos).toHaveLength(1);
	expect(published?.repos[0]?.name).toBe("nocoo/renamed");
});

it("uses the complete catalog for membership while preserving renamed repositories and unknown new data", async () => {
	const { db, lease, repo } = await setup();
	lease.run.mode = "refresh";
	await db.batch(
		await replaceSnapshotStmts(
			db,
			snap.account_id,
			"factory",
			{ ...snap, repos: [repo, { ...repo, id: "retired", name: "nocoo/retired" }] },
			now,
		),
	);
	await db.batch(
		await replaceSnapshotStmts(
			db,
			snap.account_id,
			"factory:catalog:new",
			{
				...snap,
				repos: [
					{ ...repo, name: "nocoo/renamed" },
					{ ...repo, id: "new", name: "nocoo/new" },
				],
			},
			now,
		),
	);
	await db
		.prepare("UPDATE factory_state SET catalog_id=? WHERE account_id=?")
		.bind("new", snap.account_id)
		.run();
	await db.batch(await publicationWrites(db, lease, now));
	const published = await publishedFactory(db, snap.account_id);
	expect(published?.repos.map((r) => r.name)).toEqual(["nocoo/renamed", "nocoo/new"]);
	expect(published?.repos[0]?.observation?.repo).toBe("nocoo/app");
	expect(published?.repos[1]?.coverage.commits.status).toBe("pending");
	expect(
		await (await import("./db/snapshots")).readSnapshot(db, snap.account_id, "factory"),
	).toMatchObject({ repos: [{ name: "nocoo/app" }, { name: "nocoo/retired" }] });
});

it("aggregates only current repository pointers even when a newer historical version exists", async () => {
	const { db, lease, repo } = await setup();
	lease.run.mode = "refresh";
	repo.observation = { source: "run", version: "r1", refreshedAt: now, window: snap.window };
	await db.batch(await replaceSnapshotStmts(db, snap.account_id, "factory", { ...snap }, now));
	await db.batch(await repositoryWrites(db, lease, now, repo, repo.name, null));
	await db
		.prepare("INSERT INTO factory_repo_versions VALUES(?,?,?,?,?)")
		.bind(
			snap.account_id,
			repo.name,
			"unpublished",
			JSON.stringify({ ...repo, metrics: { ...repo.metrics, commits: 9999 } }),
			"2999-01-01",
		)
		.run();
	await db.batch(await publicationWrites(db, lease, now));
	expect((await publishedFactory(db, snap.account_id))?.repos[0]?.metrics.commits).toBe(0);
});

it("preserves useful limited evidence when a subsequent result loses access or contains a smaller subset", async () => {
	const { db, lease, repo } = await setup();
	repo.coverage.commits = { ...repo.coverage.commits, status: "limited", observed: 100 };
	repo.metrics.commits = 100;
	repo.observation = { source: "run", version: "r1", refreshedAt: now, window: snap.window };
	await db.batch(await repositoryWrites(db, lease, now, repo, repo.name, null));
	for (const [status, observed] of [
		["unavailable", 0],
		["limited", 50],
	] as const) {
		const next = structuredClone(repo);
		next.coverage.commits.status = status;
		next.coverage.commits.observed = observed;
		next.metrics.commits = observed;
		await db.batch(await repositoryWrites(db, lease, now, next, repo.name, null));
		expect((await currentRepo(db, snap.account_id, repo.name))?.metrics.commits).toBe(100);
	}
});
it("retains contribution provenance across catalog-only and failed refresh publications", async () => {
	const { db, lease } = await setup();
	const calendar = { total: 2, restricted: 0, days: [], fetchedAt: now };
	const observation = { version: "original", window: snap.window, fetchedAt: now };
	await db.batch(
		await replaceSnapshotStmts(
			db,
			snap.account_id,
			"factory",
			{
				...snap,
				contribution: calendar,
				contributionStatus: "complete",
				contributionObservation: observation,
			},
			now,
		),
	);
	lease.run.checkpoint = structuredClone(snap);
	await completeCatalog(db, lease);
	await db.batch(await publicationWrites(db, lease, now));
	expect((await publishedFactory(db, snap.account_id))?.contributionObservation).toEqual(
		observation,
	);
});

it("publishes the latest rate observation without redating retained repository evidence", async () => {
	const { db, lease, repo } = await setup();
	lease.run.mode = "refresh";
	const saved = {
		remaining: 900,
		resetAt: "2026-09-15T23:00:00Z",
		resource: "graphql",
		observedAt: "2026-09-15T21:00:00Z",
	};
	const latest = { ...saved, remaining: 800, resource: "core", observedAt: now };
	repo.observation = {
		source: "legacy",
		version: "old",
		window: snap.window,
		refreshedAt: saved.observedAt,
	};
	await db.batch(
		await replaceSnapshotStmts(
			db,
			snap.account_id,
			"factory",
			{ ...snap, rate: saved, repos: [repo] },
			now,
		),
	);
	lease.run.checkpoint = { ...snap, rate: latest };
	await db.batch(await publicationWrites(db, lease, now));
	const published = await readSnapshot(db, snap.account_id, "factory:v:r1");
	expect(published).toMatchObject({
		rate: latest,
		publication: { mixed: true },
		repos: [{ observation: repo.observation }],
	});
});

it("removes an obsolete second physical page when rewriting a publication with a smaller payload", async () => {
	const { db, lease, repo } = await setup();
	const kind = "factory:v:repair";
	const big = { ...repo, description: "x".repeat(850000) };
	await db.batch(
		await snapshotWrites(db, lease, now, kind, {
			...snap,
			repos: [big, { ...big, id: "second", name: "nocoo/second" }],
		}),
	);
	const { readSnapshot } = await import("./db/snapshots");
	expect((await readSnapshot(db, snap.account_id, kind))?.repos).toHaveLength(2);
	await db.batch(await snapshotWrites(db, lease, now, kind, { ...snap, repos: [repo] }));
	expect((await readSnapshot(db, snap.account_id, kind))?.repos).toHaveLength(1);
	expect(
		(
			await db
				.prepare("SELECT kind FROM snapshots WHERE account_id=? AND kind=?")
				.bind(snap.account_id, `${kind}#2`)
				.all()
		).results,
	).toEqual([]);
});
