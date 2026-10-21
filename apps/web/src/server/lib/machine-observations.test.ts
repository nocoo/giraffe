import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { prSnapshot } from "../../lib/pull-request";
import type { Env } from "../env";
import { createApp } from "../index";
import { createDb } from "./db/d1";
import { replaceSnapshotStmts } from "./db/snapshots";
import {
	observationEnvelope,
	readFactoryResource,
	readObservation,
	requireCatalogRepo,
} from "./machine-observations";
import { readSources } from "./machine-sources";
import { statisticsSnapshot } from "./repo-statistics";

it("uses the newest saved CI evidence across historical repository casing", async () => {
	const db = createDb(sqliteFixture());
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t')",
		)
		.run();
	const old = "2026-10-18T00:00:00Z";
	const latest = "2026-10-20T00:00:00Z";
	const save = (kind: string, payload: Record<string, unknown>, at = latest) =>
		db.batch(replaceSnapshotStmts(db, "a", kind, payload, at));
	await save("repos", { repos: [{ name_with_owner: "owner/app" }] });
	for (const [name, at, branch, conclusion] of [
		["OWNER/APP", old, "main", "failure"],
		["owner/app", latest, "trunk", "success"],
	] as const) {
		await save(`repo:${name}:details`, { default_branch: branch }, at);
		await save(
			`repo:${name}:actions`,
			{
				runs: [1, 2].map((id) => ({
					id,
					name: "CI",
					status: "completed",
					conclusion,
					head_branch: branch,
					created_at: at,
					updated_at: at,
					event: "push",
				})),
			},
			at,
		);
		await save(
			`repo:${name}:releases`,
			{ releases: [{ id: 1, tag_name: at, draft: false, published_at: at }] },
			at,
		);
	}
	const result = await readObservation(db, "a", "ci", "all");
	expect(result).toMatchObject({
		freshness: { oldestAt: latest, latestAt: latest },
		data: {
			repos: [{ verdict: "healthy", release: { latest } }],
			totals: { brokenWorkflows: 0, healthyWorkflows: 1 },
		},
	});
});

it("reads the same immutable page version advertised by a case-insensitive source index", async () => {
	const db = createDb(sqliteFixture());
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t')",
		)
		.run();
	const save = (kind: string, payload: Record<string, unknown>, at = "2026-10-20T00:00:00Z") =>
		db.batch(replaceSnapshotStmts(db, "a", kind, payload, at));
	await save("repos", { repos: [{ name_with_owner: "owner/app" }] });
	await save("repo:OWNER/APP:prs", { pull_requests: [{ number: 1 }] });
	let sources = await readSources(db, "a", { repository: "OWNER/APP" });
	let page = await readObservation(db, "a", "repo:owner/app:prs", "all");
	expect(page.source.resource).toBe("repo:OWNER/APP:prs");
	expect(page.sourceVersion).toBe(
		sources.sources.find((source) => source.resource === page.source.resource)?.version,
	);
	await save("repo:owner/app:prs", { pull_requests: [{ number: 2 }] }, "2026-10-21T00:00:00Z");
	sources = await readSources(db, "a", {});
	page = await readObservation(db, "a", "repo:owner/app:prs", "all");
	expect(page.data.pull_requests).toEqual([
		{ number: 2, mergeable: null, mergeStateStatus: null, checks: { state: null } },
	]);
	expect(
		sources.sources.filter((source) => source.resource.toLowerCase() === "repo:owner/app:prs"),
	).toEqual([
		expect.objectContaining({ resource: page.source.resource, version: page.sourceVersion }),
	]);
});

it("shares catalog-wide provenance and page replacements with browser reads without statistics filtering", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t')",
		)
		.run();
	const baseline = "2026-10-18T12:50:00Z";
	const recent = "2026-10-20T12:02:00Z";
	const save = (kind: string, value: Record<string, unknown>, at = baseline) =>
		db.batch(replaceSnapshotStmts(db, "a", kind, value, at));
	await save("repos", {
		repos: ["owner/app", "owner/baseline", "owner/empty", "owner/fork"].map((name_with_owner) => ({
			name_with_owner,
			is_fork: name_with_owner === "owner/fork",
		})),
	});
	for (const name of ["OWNER/APP", "owner/baseline", "owner/empty", "owner/removed"])
		await db.prepare("INSERT INTO repo_stars VALUES('a',?)").bind(name).run();
	const before = await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all();
	for (const [resource, key] of [
		["issues", "issues"],
		["prs", "pull_requests"],
	]) {
		const snapshot = {
			[String(key)]: ["owner/app", "owner/baseline", "owner/removed", "owner/fork"].map(
				(name_with_owner) => ({ name_with_owner, number: 1 }),
			),
			repository_fetched_at: { "owner/app": recent, "owner/removed": recent },
		};
		await save(String(resource), snapshot);
		await save(`repo:OWNER/EMPTY:${resource}`, { [String(key)]: [{ number: 2 }] }, recent);
		const all = await readObservation(db, "a", String(resource), "all");
		expect(all).toMatchObject({
			fetchedAt: recent,
			freshness: { oldestAt: baseline, latestAt: recent, total: 4, missing: 0 },
			selection: { statisticsFilter: false },
		});
		expect(all.data[String(key)]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name_with_owner: "owner/fork", number: 1 }),
				expect.objectContaining({ name_with_owner: "owner/empty", number: 2 }),
			]),
		);
		expect(all.data[String(key)]).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ name_with_owner: "owner/removed" })]),
		);
		const starred = await readObservation(db, "a", String(resource), "starred");
		const browser = await statisticsSnapshot(
			db,
			"a",
			String(resource),
			{ ...snapshot, fetched_at: baseline, truncated: false },
			"starred",
		);
		expect(starred.data).toEqual(prSnapshot(browser));
	}
	expect((await raw.prepare("SELECT * FROM snapshots WHERE kind='repos'").all()).results).toEqual(
		before.results,
	);
});

it("assembles CI evidence case-insensitively and keeps missing dependencies unknown", async () => {
	const db = createDb(sqliteFixture());
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t')",
		)
		.run();
	const at = "2026-10-20T00:00:00Z";
	const save = (kind: string, value: Record<string, unknown>) =>
		db.batch(replaceSnapshotStmts(db, "a", kind, value, at));
	await save("repos", {
		repos: ["owner/app", "owner/missing", "owner/unavailable"].map((name_with_owner) => ({
			name_with_owner,
		})),
	});
	await save("repo:OWNER/APP:actions", {
		runs: [
			{
				id: 1,
				name: "CI",
				status: "completed",
				conclusion: "failure",
				head_branch: "main",
				created_at: at,
				updated_at: at,
				event: "push",
			},
		],
	});
	await save("repo:owner/missing:releases", { releases: [] });
	await save("repo:owner/unavailable:actions", { unavailable: true });
	const ci = await readObservation(db, "a", "ci", "all");
	expect(ci.data.unsaved).toEqual(["owner/missing", "owner/unavailable"]);
	expect(ci.freshness).toEqual({ oldestAt: at, latestAt: at, total: 9, missing: 7 });
	expect(ci.data.totals).toMatchObject({
		totalRepos: 1,
		brokenRepos: 0,
		nonDefaultBranchFailures: 1,
	});
});

it("does not certify health from unavailable CI dependencies and exposes any dependency truncation", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t')",
		)
		.run();
	const at = "2026-10-20T00:00:00Z";
	const save = (kind: string, value: Record<string, unknown>) =>
		db.batch(replaceSnapshotStmts(db, "a", kind, value, at));
	await save("repos", { repos: [{ name_with_owner: "owner/app" }] });
	await save("repo:owner/app:actions", {
		runs: [
			{
				id: 1,
				name: "CI",
				status: "completed",
				conclusion: "success",
				head_branch: "main",
				created_at: at,
				updated_at: at,
				event: "push",
			},
		],
	});
	await save("repo:owner/app:details", {
		default_branch: "main",
		forbidden: true,
		truncated: true,
	});
	await save("repo:owner/app:releases", {
		releases: [{ id: 1, tag_name: "v1", draft: false, published_at: at }],
		unavailable: true,
		truncated: true,
	});
	const ci = await readObservation(db, "a", "ci", "all");
	expect(ci).toMatchObject({
		truncated: true,
		freshness: { total: 3, missing: 2 },
		data: {
			totals: { totalWorkflows: 0, healthyRepos: 0, unknownRepos: 1, truncatedRepos: 1 },
			repos: [{ release: null, verdict: "unknown", truncated: true }],
		},
	});
	await save("repo:owner/app:actions", { unavailable: true, truncated: true });
	expect(await readObservation(createDb(raw), "a", "ci", "all")).toMatchObject({
		truncated: true,
		data: { repos: [], unsaved: ["owner/app"] },
	});
});

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
		ranges: [{ since: "pending", until: "queue" }],
	};
	snap.window = { since: "2026-09-01T00:00:00Z", until: "2026-10-21T00:00:00Z" };
	await save("factory:v:pub", snap);
	await db
		.prepare("INSERT INTO factory_resources VALUES(?,?,?,?)")
		.bind("r", repo.name, "commits", JSON.stringify(resource))
		.run();
	expect(await readFactoryResource(db, a, repo.name, "commits")).toMatchObject({
		sourceVersion: "r",
		truncated: true,
		source: { publicationId: "pub" },
		data: { ranges: [repo.observation.window] },
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
	expect(await readFactoryResource(db, a, repo.name, "commits")).toMatchObject({
		truncated: false,
		data: { ranges: [repo.observation.window] },
	});
	delete repo.observation;
	await save("factory:v:pub", snap);
	expect((await readFactoryResource(db, a, repo.name, "commits")).data.ranges).toEqual([
		snap.window,
	]);
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

it.each(["run", "legacy"] as const)(
	"normalizes saved %s dependency evidence without changing source rows or versions",
	async (source) => {
		const raw = sqliteFixture();
		const db = createDb(raw);
		const snap = factoryFixture();
		const repo = snap.repos[0];
		if (!repo) throw new Error("fixture");
		await db
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake','t','t')",
			)
			.bind(snap.account_id)
			.run();
		const save = (kind: string, payload: Record<string, unknown>) =>
			db.batch(replaceSnapshotStmts(db, snap.account_id, kind, payload, snap.fetched_at));
		repo.observation = { version: "r", source, window: snap.window, refreshedAt: snap.fetched_at };
		repo.dependencies = [
			{ name: "@scope/root", version: "1", path: "package.json#name", url: "root" },
			{
				name: "@scope/child",
				version: "2",
				path: "packages/child/package.json#name",
				url: "child",
			},
			{
				name: "@scope/child",
				version: "workspace:*",
				path: "package.json#dependencies",
				url: "self",
			},
			{ name: "app", version: "^3", path: "package.json#dependencies", url: "external" },
		];
		repo.manifests = [
			{ name: "@scope/known", version: "1", path: "packages/known/package.json", url: "known" },
		];
		const data = {
			runId: "r",
			next: null,
			ranges: [],
			coverage: { ...repo.coverage.dependencies, status: "complete", fetchedAt: snap.fetched_at },
			manifests: [],
			items: [
				...repo.dependencies,
				{
					name: "@scope/known",
					version: "workspace:*",
					path: "package.json#dependencies",
					url: "known",
				},
			].map((dependency, index) => ({
				id: String(index),
				title: dependency.name,
				version: dependency.version,
				path: dependency.path,
				url: dependency.url,
				at: "",
				createdAt: "",
				author: "",
				closedAt: null,
				mergedAt: null,
				state: "declared",
			})),
		};
		await save("repos", { repos: [{ name_with_owner: repo.name }] });
		await save("factory", { ...snap });
		if (source === "run") {
			await db
				.prepare(
					"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('r',?,'k','completed','{}','t','t','t')",
				)
				.bind(snap.account_id)
				.run();
			await db
				.prepare("INSERT INTO factory_resources VALUES('r',?,'dependencies',?)")
				.bind(repo.name, JSON.stringify(data))
				.run();
		} else await save(`factory:${repo.name}:dependencies`, data);
		const before = await db.prepare("SELECT kind,payload FROM snapshots ORDER BY kind").all();
		const resources = await db.prepare("SELECT * FROM factory_resources").all();
		const stream = await readFactoryResource(db, snap.account_id, repo.name, "dependencies");
		expect(stream).toMatchObject({
			sourceVersion: "r",
			data: {
				items: [{ title: "app", at: null, createdAt: null, author: null }],
				manifests: [
					{ name: "@scope/known", path: "packages/known/package.json" },
					{ name: "@scope/root", path: "package.json" },
					{ name: "@scope/child", path: "packages/child/package.json" },
				],
			},
		});
		const publication = await readObservation(db, snap.account_id, "factory", "all");
		expect(publication.data.repos).toMatchObject([
			{
				dependencies: [{ name: "app" }],
				manifests: [{ name: "@scope/known" }, { name: "@scope/root" }, { name: "@scope/child" }],
			},
		]);
		expect(
			(await db.prepare("SELECT kind,payload FROM snapshots ORDER BY kind").all()).results,
		).toEqual(before.results);
		expect((await db.prepare("SELECT * FROM factory_resources").all()).results).toEqual(
			resources.results,
		);
	},
);

it.each(["running", "completed"])(
	"projects the latest saved catalog rate over an older publication (%s)",
	async (status) => {
		const raw = sqliteFixture();
		const db = createDb(raw);
		const snap = factoryFixture();
		await db
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake','t','t')",
			)
			.bind(snap.account_id)
			.run();
		await db.prepare("UPDATE accounts SET is_active=1").run();
		const read = async () =>
			(
				await createApp().request("http://localhost/api/factory", {}, {
					DB: raw,
					ENVIRONMENT: "development",
					GITHUB_API_BASE: "http://127.0.0.1:17046",
				} as Env)
			).json();
		await db.batch(
			replaceSnapshotStmts(
				db,
				snap.account_id,
				"repos",
				{ repos: snap.repos.map((repo) => ({ name_with_owner: repo.name })) },
				snap.fetched_at,
			),
		);
		const older = {
			remaining: 700,
			resetAt: new Date(Date.now() + 3_600_000).toISOString(),
			resource: "core",
			observedAt: new Date(Date.now() - 120_000).toISOString(),
		};
		const latest = {
			...older,
			remaining: 600,
			resource: "graphql",
			observedAt: new Date(Date.now() - 60_000).toISOString(),
		};
		await db.batch(
			replaceSnapshotStmts(
				db,
				snap.account_id,
				"factory",
				{ ...snap, rate: older },
				snap.fetched_at,
			),
		);
		await db
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('catalog',?,'k',?,?,'t','t','2999-01-01')",
			)
			.bind(
				snap.account_id,
				status,
				JSON.stringify({ mode: "catalog", checkpoint: { rate: latest } }),
			)
			.run();
		const before = (await db.prepare("SELECT * FROM factory_runs").all()).results;
		const saved = (await db.prepare("SELECT kind,payload FROM snapshots ORDER BY kind").all())
			.results;
		expect(await read()).toMatchObject({ runId: snap.runId, rate: latest });
		await db
			.prepare(
				"UPDATE factory_runs SET payload=json_set(payload,'$.checkpoint.rate.resetAt',?) WHERE id='catalog'",
			)
			.bind(new Date(Date.now() - 1_000).toISOString())
			.run();
		expect(await read()).toMatchObject({ rate: null });
		await db
			.prepare("UPDATE factory_runs SET payload=? WHERE id='catalog'")
			.bind(before[0]?.payload)
			.run();
		expect((await db.prepare("SELECT * FROM factory_runs").all()).results).toEqual(before);
		expect(
			(await db.prepare("SELECT kind,payload FROM snapshots ORDER BY kind").all()).results,
		).toEqual(saved);
	},
);

it.each([
	{ remaining: 100, resetAt: "2999-01-01T00:00:00Z", resource: "core" },
	{ remaining: 100, resetAt: "invalid", resource: "core", observedAt: "2026-10-20T00:00:00Z" },
	{
		remaining: 100,
		resetAt: "2026-09-16T00:00:00Z",
		resource: "core",
		observedAt: "2026-09-15T22:00:00Z",
	},
])(
	"hides invalid or undated saved publication rates without inventing observation times",
	async (rate) => {
		const raw = sqliteFixture();
		const db = createDb(raw);
		const snap = factoryFixture();
		await db
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake','t','t')",
			)
			.bind(snap.account_id)
			.run();
		await db.prepare("UPDATE accounts SET is_active=1").run();
		await db.batch(
			replaceSnapshotStmts(db, snap.account_id, "factory", { ...snap, rate }, snap.fetched_at),
		);
		expect(
			await (
				await createApp().request("http://localhost/api/factory", {}, {
					DB: raw,
					ENVIRONMENT: "development",
					GITHUB_API_BASE: "http://127.0.0.1:17046",
				} as Env)
			).json(),
		).toMatchObject({ rate: null });
	},
);
