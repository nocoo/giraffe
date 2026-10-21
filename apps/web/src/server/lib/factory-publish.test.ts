import { expect, it } from "vitest";
import { github, memoryStore, ready } from "../../../../../tests/fixtures/factory";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import { FACTORY_STREAMS } from "../../lib/factory-types";
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
it("preserves stronger last-known-good coverage and failed-repository metadata in one atomic commit", async () => {
	const { raw, db, lease, repo } = await setup();
	for (const key of FACTORY_STREAMS) repo.coverage[key].status = "complete";
	repo.observation = { version: "r1", refreshedAt: now, window: snap.window, source: "run" };
	await db.batch(await repositoryWrites(db, lease, now, repo, repo.name, null));
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

it("retains the published repository when workflow jobs cannot be parsed", async () => {
	const { db, lease, repo } = await setup();
	for (const stream of FACTORY_STREAMS) repo.coverage[stream].status = "complete";
	repo.dependencies = [
		{ name: "actions/checkout", version: "v4", path: ".github/workflows/ci.yml", url: "saved" },
	];
	repo.observation = { version: "r1", refreshedAt: now, window: snap.window, source: "run" };
	await db.batch(await repositoryWrites(db, lease, now, repo, repo.name, null));
	const before = await currentRepo(db, snap.account_id, repo.name);
	const state = ready("dependencies");
	state.repos = [structuredClone(repo)];
	const candidate = state.repos[0];
	if (!candidate) throw new Error("fixture");
	candidate.observation = {
		...repo.observation,
		version: "r2",
		refreshedAt: "2026-10-21T00:00:00Z",
	};
	await stepFactory(
		state,
		github(() => Response.json({ data: { repository: { ci: { text: "jobs: *shared" } } } })),
		"test-token",
		memoryStore(),
		now,
	);
	await db.batch(await repositoryWrites(db, lease, now, candidate, repo.name, null));
	expect(await currentRepo(db, snap.account_id, repo.name)).toEqual(before);
	expect((await repoStates(db, snap.account_id))[0]).toMatchObject({
		version: "r1",
		error: "coverage_regression_retained",
	});
});
it("fails closed at storage limits and for missing publication input", async () => {
	const { db, lease } = await setup();
	expect(() => boundedJson("x".repeat(1_800_001))).toThrow("capacity");
	expect(() =>
		snapshotWrites(db, lease, now, "factory:v:large", { ...snap, owner: "x".repeat(3_100_000) }),
	).toThrow("capacity");
	await expect(publicationWrites(db, lease, now)).rejects.toMatchObject({
		code: "snapshot_missing",
	});
});

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
	await db.batch(replaceSnapshotStmts(db, snap.account_id, "factory:v:existing", { ...snap }, now));
	await db
		.prepare("UPDATE factory_state SET published_id=? WHERE account_id=?")
		.bind("existing", snap.account_id)
		.run();
	lease.run.checkpoint = { ...snap, repos: [repo] };
	await db.batch(await publicationWrites(db, lease, now));
	expect((await publishedFactory(db, snap.account_id))?.runId).toBe(snap.runId);
});
it("recovers only matching legacy resource versions and does not invent missing data", async () => {
	const { db, lease, repo } = await setup();
	expect(await restoreLegacyRepo(db, lease, now, repo)).toEqual([]);
	await db.batch([
		...replaceSnapshotStmts(
			db,
			snap.account_id,
			"factory:nocoo/app:commits",
			{ runId: now, items: [], coverage: { ...repo.coverage.commits, status: "partial" } },
			now,
		),
		...replaceSnapshotStmts(
			db,
			snap.account_id,
			"factory:nocoo/app:issues",
			{ runId: "another", items: [], coverage: repo.coverage.issues },
			now,
		),
		...replaceSnapshotStmts(
			db,
			snap.account_id,
			"factory:nocoo/app:dependencies",
			{
				runId: now,
				items: [{ id: "one", title: "package", url: "https://github.com/nocoo/app", at: now }],
				coverage: { ...repo.coverage.dependencies, status: "complete" },
			},
			now,
		),
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
	const declarations = [
		{ name: "own", path: "package.json#name" },
		{ name: "child", path: "packages/child/package.json#name" },
		{ name: "child", path: "package.json#dependencies" },
		{ name: "external", path: "package.json#dependencies" },
	];
	await db.batch(
		replaceSnapshotStmts(
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

it("deduplicates renamed repositories by stable GitHub identity at publication", async () => {
	const { db, lease, repo } = await setup();
	await db.batch(replaceSnapshotStmts(db, snap.account_id, "factory", { ...snap }, now));
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
		replaceSnapshotStmts(
			db,
			snap.account_id,
			"factory",
			{ ...snap, repos: [repo, { ...repo, id: "retired", name: "nocoo/retired" }] },
			now,
		),
	);
	await db.batch(
		replaceSnapshotStmts(
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
	await db.batch(replaceSnapshotStmts(db, snap.account_id, "factory", { ...snap }, now));
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
		replaceSnapshotStmts(
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
		replaceSnapshotStmts(
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
		snapshotWrites(db, lease, now, kind, {
			...snap,
			repos: [big, { ...big, id: "second", name: "nocoo/second" }],
		}),
	);
	const { readSnapshot } = await import("./db/snapshots");
	expect((await readSnapshot(db, snap.account_id, kind))?.repos).toHaveLength(2);
	await db.batch(snapshotWrites(db, lease, now, kind, { ...snap, repos: [repo] }));
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
