import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { createDb } from "./db/d1";
import { replaceSnapshotStmts } from "./db/snapshots";
import {
	observationEnvelope,
	readFactoryResource,
	readObservation,
	requireCatalogRepo,
} from "./machine-observations";

it("exposes saved unfiltered sources without writes or upstream fetches", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	const snap = factoryFixture();
	const a = snap.account_id;
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?, 'nocoo','fake','fake','t','t')",
		)
		.bind(a)
		.run();
	const save = async (kind: string, value: Record<string, unknown>) =>
		db.batch(replaceSnapshotStmts(db, a, kind, value, snap.fetched_at));
	await save("repos", {
		repos: [
			{ name_with_owner: "nocoo/app", is_archived: true },
			{ name_with_owner: "nocoo/other" },
		],
	});
	await db.prepare("INSERT INTO repo_stars(account_id,repo) VALUES(?,'nocoo/app')").bind(a).run();
	await save("issues", {
		issues: [{ name_with_owner: "nocoo/app" }, { name_with_owner: "nocoo/other" }],
		repository_fetched_at: { "nocoo/app": snap.fetched_at, "nocoo/other": snap.fetched_at },
	});
	expect(await requireCatalogRepo(db, a, "NOCOO/APP")).toBe("nocoo/app");
	await expect(requireCatalogRepo(db, a, "nocoo/no")).rejects.toMatchObject({ status: 404 });
	const all = await readObservation(db, a, "repos", "all");
	expect(all.data.repos).toHaveLength(2);
	expect(all.selection.statisticsFilter).toBe(false);
	const stars = await readObservation(db, a, "issues", "starred");
	expect(stars.data.issues).toHaveLength(1);
	expect(stars.sourceVersion).toMatch(/^sha256:/);
	const ci = await readObservation(db, a, "ci", "all");
	expect(ci.freshness).toMatchObject({ missing: 6 });
	await expect(readObservation(db, a, "prs", "all")).rejects.toMatchObject({ status: 409 });
	await expect(readObservation(db, a, "factory", "all")).rejects.toMatchObject({ status: 409 });
	await expect(readFactoryResource(db, a, "nocoo/app", "invalid")).rejects.toMatchObject({
		status: 400,
	});
	await expect(readFactoryResource(db, a, "nocoo/app", "commits")).rejects.toMatchObject({
		status: 404,
	});
	await save("factory:v:pub", snap);
	await db
		.prepare("INSERT INTO factory_state(account_id,published_id,next_at) VALUES(?,'pub','t')")
		.bind(a)
		.run();
	expect((await readObservation(db, a, "factory", "all")).source.kind).toBe("factory");
	const name = snap.repos[0]?.name as string;
	await expect(readFactoryResource(db, a, name, "commits")).rejects.toMatchObject({ status: 409 });
	await save(`factory:${name}:commits`, {
		runId: snap.runId,
		coverage: { status: "complete", fetchedAt: snap.fetched_at },
		items: [],
	});
	const rawEnvelope = await observationEnvelope(a, "x", { forbidden: true });
	expect(rawEnvelope).toMatchObject({ fetchedAt: null, unavailable: true, coverage: null });
});

it("preserves immutable run resources, missing coverage and mixed source flags", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	const snap = factoryFixture();
	const a = snap.account_id;
	const repo = snap.repos[0];
	if (!repo) throw new Error("fixture repo missing");
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake','t','t')",
		)
		.bind(a)
		.run();
	const save = async (kind: string, value: Record<string, unknown>) =>
		db.batch(replaceSnapshotStmts(db, a, kind, value, snap.fetched_at));
	await save("repos", {
		repos: [{ name_with_owner: repo.name }, { name_with_owner: "nocoo/empty" }],
	});
	await save(`repo:${repo.name}:actions`, { runs: [], truncated: true });
	await save(`repo:${repo.name}:releases`, { releases: [] });
	await save(`repo:${repo.name}:details`, { default_branch: "develop" });
	expect((await readObservation(db, a, "ci", "all")).data.unsaved).toEqual(["nocoo/empty"]);
	await save("prs", { pull_requests: [] });
	expect((await readObservation(db, a, "prs", "starred")).data.pull_requests).toEqual([]);
	snap.publication = { runId: "pub", mixed: false, publishedAt: snap.fetched_at };
	repo.observation = {
		version: "r",
		source: "run",
		repo: repo.name,
		window: snap.window,
		refreshedAt: snap.fetched_at,
	};
	await save("factory:v:pub", snap);
	await db
		.prepare("INSERT INTO factory_state(account_id,published_id,next_at) VALUES(?,'pub','t')")
		.bind(a)
		.run();
	await db
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('r',?,'k','completed','{}','t','t','t')",
		)
		.bind(a)
		.run();
	await expect(readFactoryResource(db, a, repo.name, "commits")).rejects.toMatchObject({
		status: 409,
	});
	const resource = {
		runId: "r",
		coverage: { status: "limited", fetchedAt: snap.fetched_at },
		items: [],
	};
	await db
		.prepare("INSERT INTO factory_resources VALUES(?,?,?,?)")
		.bind("r", repo.name, "commits", JSON.stringify(resource))
		.run();
	expect(await readFactoryResource(db, a, repo.name, "commits")).toMatchObject({
		sourceVersion: "r",
		truncated: true,
		source: { publicationId: "pub" },
	});
	resource.coverage.status = "unavailable";
	await db.prepare("UPDATE factory_resources SET payload=?").bind(JSON.stringify(resource)).run();
	expect((await readFactoryResource(db, a, repo.name, "commits")).unavailable).toBe(true);
	expect((await readObservation(db, a, "factory", "starred")).data.repos).toEqual([]);
	repo.observation.source = "legacy";
	repo.observation.version = snap.runId;
	await save("factory:v:pub", snap);
	await save(`factory:${repo.name}:commits`, {
		runId: snap.runId,
		coverage: { status: "complete", fetchedAt: snap.fetched_at },
		items: [],
	});
	expect((await readFactoryResource(db, a, repo.name, "commits")).truncated).toBe(false);
	expect(
		(
			await observationEnvelope(a, "x", {
				repository_fetched_at: { a: null, b: "bad" },
				freshness: { total: 2 },
				unavailable: true,
			})
		).unavailable,
	).toBe(true);
});
