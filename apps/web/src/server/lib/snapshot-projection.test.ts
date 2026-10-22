import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { storedContent } from "./content-version";
import { createDb } from "./db/d1";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { readObservation } from "./machine-observations";
import {
	policyFromSaved,
	projectFactory,
	projectSnapshot,
	repoPolicy,
	scopedSnapshot,
} from "./snapshot-projection";
import { selectionFromStars } from "./snapshot-scope";

it.each(["all", "starred"] as const)(
	"projects selected unpublished membership without inventing %s observations",
	(scope) => {
		const snapshot = factoryFixture();
		const before = structuredClone(snapshot);
		const catalog = {
			repos: [
				{ name_with_owner: "nocoo/app", primary_language: "TypeScript" },
				{ name_with_owner: "nocoo/missing", description: "Unpublished", primary_language: "Swift" },
				{ name_with_owner: "outside/foreign" },
			],
		};
		const selection = selectionFromStars(
			catalog.repos.map((repo) => ({
				repo: repo.name_with_owner,
				starred: 1,
				source: "owner" as const,
				updated_at: snapshot.fetched_at,
				reason: null,
			})),
			scope,
		);
		const projected = projectFactory(snapshot, policyFromSaved(catalog, selection, "nocoo"));
		expect(projected.selectedRepos).toEqual([
			{ name: "nocoo/app", description: "Example", language: "TypeScript", topics: ["cli"] },
			{ name: "nocoo/missing", description: "Unpublished", language: "Swift", topics: null },
		]);
		expect(projected.repos).toEqual(before.repos);
		expect(snapshot).toEqual(before);
	},
);

it.each([
	["issues", "issues"],
	["prs", "pull_requests"],
])(
	"composes %s content from the selected repository snapshots, not observation times",
	async (kind, key) => {
		const db = createDb(sqliteFixture());
		await db
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t')",
			)
			.run();
		const save = async (resource: string, data: Record<string, unknown>, at: string) =>
			db.batch(await replaceSnapshotStmts(db, "a", resource, data, at));
		await save("repos", { repos: [{ name_with_owner: "owner/app" }] }, "2026-10-18T00:00:00Z");
		await save(
			kind,
			{ [key]: [{ name_with_owner: "owner/app", number: 1 }] },
			"2026-10-18T00:00:00Z",
		);
		const project = async () => {
			const snapshot = await readSnapshot(db, "a", kind);
			if (!snapshot) throw new Error("missing snapshot");
			return projectSnapshot(db, "a", kind, snapshot, await repoPolicy(db, "a"));
		};
		const first = await project();
		expect(storedContent(first)?.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
		const next = { [key]: [{ name_with_owner: "owner/app", number: 2 }] };
		await save(`repo:owner/app:${kind}`, next, "2026-10-19T00:00:00Z");
		const second = await project();
		expect(second[key]).toEqual(next[key]);
		expect(storedContent(second)?.hash).not.toBe(storedContent(first)?.hash);
		await save(`repo:owner/app:${kind}`, next, "2026-10-20T00:00:00Z");
		const refreshed = await project();
		expect(refreshed.fetched_at).not.toBe(second.fetched_at);
		expect(storedContent(refreshed)?.hash).toBe(storedContent(second)?.hash);
		await db
			.prepare("UPDATE snapshots SET content_meta=NULL WHERE kind=?")
			.bind(`repo:owner/app:${kind}`)
			.run();
		expect(storedContent(await project())).toBeNull();
		await save(kind, next, "2026-10-21T00:00:00Z");
		expect(storedContent(await project())?.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
	},
);

it("keeps legacy dependencies null, absent dependencies distinct, and catalog flags in projected hashes", async () => {
	const db = createDb(sqliteFixture());
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t')",
		)
		.run();
	const catalog = { repos: [{ name_with_owner: "owner/app" }] };
	const save = async (
		resource: string,
		data: Record<string, unknown>,
		at = "2026-10-18T00:00:00Z",
	) => db.batch(await replaceSnapshotStmts(db, "a", resource, data, at));
	const project = async (kind: string) => {
		const snapshot = await readSnapshot(db, "a", kind);
		if (!snapshot) throw new Error("missing snapshot");
		return projectSnapshot(db, "a", kind, snapshot, await repoPolicy(db, "a"));
	};
	await save("issues", { issues: [] });
	const absent = storedContent(await project("issues"))?.hash;
	expect(absent).toMatch(/^sha256:[a-f0-9]{64}$/);
	await save("repos", catalog);
	await db.prepare("UPDATE snapshots SET content_meta=NULL WHERE kind='repos'").run();
	expect(storedContent(await project("issues"))).toBeNull();
	await save("repos", catalog);
	expect(storedContent(await project("issues"))?.hash).not.toBe(absent);
	const covered = await project("issues");
	await save("repos", catalog, "2026-10-19T00:00:00Z");
	const missing = await project("issues");
	expect(missing.freshness).toMatchObject({ total: 1, missing: 1 });
	expect(storedContent(missing)?.hash).not.toBe(storedContent(covered)?.hash);
	await save("issues", { issues: [] }, "2026-10-19T00:00:00Z");
	expect(storedContent(await project("issues"))?.hash).toBe(storedContent(covered)?.hash);
	await db.prepare("UPDATE snapshots SET content_meta=NULL WHERE kind='issues'").run();
	expect(storedContent(await project("issues"))).toBeNull();
	const initial = await project("repos");
	const initialJson = JSON.stringify(initial);
	const first = storedContent(initial)?.hash;
	await save("repos", catalog, "2026-10-19T00:00:00Z");
	expect(storedContent(await project("repos"))?.hash).toBe(first);
	await db.prepare("INSERT INTO repo_statistics VALUES('a','owner/app',0)").run();
	const disabled = storedContent(await project("repos"))?.hash;
	expect(disabled).toBe(first);
	await db.prepare("INSERT INTO repo_stars(account_id,repo) VALUES('a','owner/app')").run();
	expect(storedContent(await project("repos"))?.hash).not.toBe(disabled);
	expect(JSON.stringify(initial)).toBe(initialJson);
	expect(initial).not.toHaveProperty("content_meta");
});

it("uses saved catalog membership for all selectors and never revives removed repositories", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t')",
		)
		.run();
	await db.batch(
		await replaceSnapshotStmts(
			db,
			"a",
			"repos",
			{ repos: [{ name_with_owner: "Owner/App" }] },
			"2026-10-18",
		),
	);
	await db.prepare("INSERT INTO repo_stars(account_id,repo) VALUES('a','owner/removed')").run();
	await db.prepare("INSERT INTO repo_statistics VALUES('a','owner/removed',1)").run();
	const all = await repoPolicy(db, "a");
	expect(all.includes("OWNER/APP")).toBe(true);
	expect(all.includes("owner/removed")).toBe(false);
	expect(all.includes("owner/removed")).toBe(false);
	const stars = await repoPolicy(db, "a", undefined, "starred");
	expect(stars.includes("owner/removed")).toBe(false);
	expect(stars.empty).toBe(true);
	for (const [kind, key] of [
		["issues", "issues"],
		["prs", "pull_requests"],
		["notifications", "notifications"],
		["alerts", "items"],
	]) {
		const snapshot = {
			[String(key)]: [{ name_with_owner: "OWNER/APP" }, { name_with_owner: "owner/removed" }],
			fetched_at: "2026-10-18",
		};
		expect(await scopedSnapshot(db, "a", String(kind), snapshot)).toMatchObject({
			[String(key)]: [{ name_with_owner: "OWNER/APP" }],
			freshness: { total: 1 },
		});
	}
});

it("includes baseline timestamps for the entire catalog and for served incomplete data", async () => {
	const db = createDb(sqliteFixture());
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t')",
		)
		.run();
	const baseline = "2026-10-18T12:50:00Z";
	const recent = "2026-10-20T12:02:00Z";
	await db.batch(
		await replaceSnapshotStmts(
			db,
			"a",
			"repos",
			{
				repos: ["owner/app", "owner/baseline", "owner/empty"].map((name_with_owner) => ({
					name_with_owner,
				})),
			},
			baseline,
		),
	);
	for (const [kind, key] of [
		["issues", "issues"],
		["prs", "pull_requests"],
		["repos", "repos"],
	]) {
		const snapshot = {
			[String(key)]: ["owner/app", "owner/baseline"].map((name_with_owner) => ({
				name_with_owner,
			})),
			repository_fetched_at: { "OWNER/APP": recent, "owner/removed": recent },
			fetched_at: baseline,
			truncated: false,
		};
		const result = await scopedSnapshot(db, "a", String(kind), snapshot);
		expect(result).toMatchObject({
			fetched_at: recent,
			freshness: {
				total: kind === "repos" ? 2 : 3,
				missing: 0,
				oldestAt: baseline,
				latestAt: recent,
			},
		});
		expect(result.repository_fetched_at).not.toHaveProperty("owner/removed");
	}
	const partial = await scopedSnapshot(db, "a", "issues", {
		issues: [{ name_with_owner: "owner/baseline" }],
		fetched_at: baseline,
		truncated: true,
	});
	expect(partial).toMatchObject({
		fetched_at: baseline,
		freshness: { oldestAt: baseline, latestAt: baseline, total: 3, missing: 2 },
	});
});

it("keeps raw snapshots immutable and excludes factory entries without a saved catalog", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	const snapshot = factoryFixture();
	const first = snapshot.repos[0];
	if (!first) throw new Error("fixture");
	snapshot.repos = [{ ...first, is_fork: true }];
	snapshot.inventory.excluded = [
		{ name: first.name, reason: "fork" },
		{ name: "outside/other", reason: "not-owner" },
	];
	const before = structuredClone(snapshot);
	const policy = await repoPolicy(db, "absent");
	expect(projectFactory(snapshot, policy).repos).toEqual([]);
	expect(projectFactory(snapshot, policy).inventory.excluded).toEqual([]);
	expect(snapshot).toEqual(before);
	expect(await scopedSnapshot(db, "absent", "unknown", { fetched_at: "t" })).toEqual({
		fetched_at: "t",
	});
	expect(await scopedSnapshot(db, "absent", "issues", {})).toEqual({});
	expect(
		await scopedSnapshot(db, "absent", "alerts", { items: [{ source: "code_scanning" }, {}] }),
	).toMatchObject({ code_scanning_open: 0, dependabot_open: 0 });
});

it.each(["pending", "complete", "unavailable"] as const)(
	"preserves the exact saved account calendar and %s status unless the scope is starred",
	async (status) => {
		const raw = sqliteFixture();
		const db = createDb(raw);
		const snapshot = factoryFixture();
		const account = snapshot.account_id;
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("fixture");
		await db
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake','t','t')",
			)
			.bind(account)
			.run();
		await db.batch(
			await replaceSnapshotStmts(
				db,
				account,
				"repos",
				{ repos: [{ name_with_owner: repo.name }, { name_with_owner: "nocoo/disabled" }] },
				snapshot.fetched_at,
			),
		);
		await db
			.prepare("INSERT INTO repo_stars(account_id,repo) VALUES(?,'NOCOO/APP')")
			.bind(account)
			.run();
		await db
			.prepare("INSERT INTO repo_statistics VALUES(?,'nocoo/disabled',0)")
			.bind(account)
			.run();
		snapshot.repos.push({ ...repo, name: "nocoo/disabled" }, { ...repo, name: "nocoo/removed" });
		snapshot.inventory.excluded = [{ name: "nocoo/removed", reason: "archived" }];
		const counts = [48, 350, 329, 209, 298, 375];
		snapshot.contribution = {
			days: Array.from({ length: 90 }, (_, index) => ({
				date: new Date(Date.UTC(2026, 6, 20 + index)).toISOString().slice(0, 10),
				count: index < 84 ? index % 7 : (counts[index - 84] as number),
			})),
			total: 1861,
			restricted: 71,
			fetchedAt: "2026-10-18T00:00:00.000Z",
		};
		snapshot.contributionStatus = status;
		snapshot.contributionObservation = {
			version: "retained-calendar-version",
			window: { since: "2026-07-20T00:00:00.000Z", until: "2026-10-18T00:00:00.000Z" },
			fetchedAt: snapshot.contribution.fetchedAt,
		};
		const before = structuredClone(snapshot);
		const saved = await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all();
		{
			const all = projectFactory(snapshot, await repoPolicy(db, account));
			expect(all.contribution).toEqual(before.contribution);
			expect(all.contributionStatus).toBe(status);
			expect(all.contributionObservation).toEqual(before.contributionObservation);
			expect(all).not.toHaveProperty("contributionExcluded");
			expect(all.repos.map((item) => item.name)).toEqual([repo.name, "nocoo/disabled"]);
			expect(all.inventory.excluded).toEqual([]);
			const starred = projectFactory(snapshot, await repoPolicy(db, account, undefined, "starred"));
			expect(starred).toMatchObject({
				repos: [{ name: repo.name }],
				contribution: null,
				contributionExcluded: true,
				contributionStatus: "unavailable",
			});
			expect(starred).not.toHaveProperty("contributionObservation");
		}
		expect(snapshot).toEqual(before);
		expect(await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(saved);
	},
);

it.each([
	["issues", "issues", "issues"],
	["prs", "pull_requests", "prs"],
	["alerts", "items", "security"],
])(
	"preserves incomplete %s coverage independently of observed timestamps",
	async (kind, key, suffix) => {
		const db = createDb(sqliteFixture());
		await db
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t')",
			)
			.run();
		const at = "2026-10-18T12:50:00Z";
		await db.batch(
			await replaceSnapshotStmts(
				db,
				"a",
				"repos",
				{ repos: [{ name_with_owner: "owner/app" }] },
				at,
			),
		);
		await db.prepare("INSERT INTO repo_stars(account_id,repo) VALUES('a','owner/app')").run();
		const partial = {
			[key]: [{ name_with_owner: "owner/app", number: 1 }],
			fetched_at: at,
			truncated: true,
		};
		expect(await scopedSnapshot(db, "a", kind, partial, "starred")).toMatchObject({
			truncated: true,
			freshness: { total: 1, missing: 0, oldestAt: at },
		});
		await db.batch(
			await replaceSnapshotStmts(db, "a", `repo:owner/app:${suffix}`, { [key]: [] }, at),
		);
		expect(await scopedSnapshot(db, "a", kind, partial, "starred")).toMatchObject({
			[key]: [],
			truncated: false,
			freshness: { total: 1, missing: 0, oldestAt: at },
		});
	},
);

it("handles first-day baselines and incomplete source metadata without invented deltas", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','o','encrypted','fake','t','t')",
		)
		.run();
	await db.batch(
		await replaceSnapshotStmts(
			db,
			"a",
			"repos",
			{ repos: [null, {}, { name_with_owner: "o/r", pushed_at: "2026-09-01" }], truncated: true },
			"2026-09-18",
		),
	);
	expect(await scopedSnapshot(db, "a", "insights", { fetched_at: "2026-09-18" })).toMatchObject({
		alerts_incomplete: true,
		insights: [{ name_with_owner: "o/r", open_issue_count: 0 }],
	});
});

it("applies the additive migration repeatedly without losing existing rows", () => {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8"));
	db.exec(
		"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','o','encrypted','fake','t','t'); INSERT INTO repo_statistics VALUES('a','o/r',0)",
	);
	const migration = readFileSync("migrations/0004_repo_statistics.sql", "utf8");
	db.exec(migration);
	db.exec(migration);
	expect(db.prepare("SELECT enabled FROM repo_statistics").get()).toMatchObject({ enabled: 0 });
	db.close();
});

it("deduplicates legacy dependency summaries per repo in first-seen order without inventing ids", async () => {
	const publication = factoryFixture();
	const repo = publication.repos[0];
	if (!repo) throw new Error("fixture");
	const upload = {
		name: "actions/upload-artifact",
		version: "v4",
		path: ".github/workflows/ci.yml",
		url: "https://github.com/nocoo/app/blob/abc/.github/workflows/ci.yml",
	};
	const distinct = [
		upload,
		{ ...upload, version: "v3" },
		{ ...upload, path: ".github/workflows/release.yml" },
		{ ...upload, name: "actions/download-artifact" },
		{ ...upload, url: "other-saved-url" },
		{ name: "external", version: "^1", path: "package.json#dependencies", url: "package" },
	];
	repo.dependencies = [
		...Array.from({ length: 7 }, () => ({ ...upload })),
		...distinct.slice(1),
		...distinct.map(({ name, version, path, url }) => ({ url, path, version, name })),
	];
	publication.repos.push({ ...repo, name: "nocoo/second" });
	const before = structuredClone(publication);
	const db = createDb(sqliteFixture());
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake','t','t')",
		)
		.bind(publication.account_id)
		.run();
	const policy = await repoPolicy(db, publication.account_id, {
		repos: publication.repos.map(({ name }) => ({ name_with_owner: name })),
	});
	const statements = db.statements;
	const normalized = projectFactory(publication, policy);
	for (const item of normalized.repos) {
		expect(item.dependencies).toEqual(distinct);
		for (const dependency of item.dependencies) expect(dependency).not.toHaveProperty("id");
	}
	expect(normalized.repos[0]?.dependencies[0]).toBe(repo.dependencies[0]);
	expect(projectFactory(normalized, policy)).toEqual(normalized);
	expect(db.statements).toBe(statements);
	expect(publication).toEqual(before);
});

it.each(["factory", "factory:v:r1"])(
	"normalizes %s summary reads without extra queries or stored changes",
	async (kind) => {
		const raw = sqliteFixture();
		const db = createDb(raw);
		const publication = factoryFixture();
		const account = publication.account_id;
		const now = publication.fetched_at;
		await db
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake','t','t')",
			)
			.bind(account)
			.run();
		const repo = publication.repos[0];
		if (!repo) throw new Error("fixture");
		const dependency = { name: "external", version: "^1", path: "package.json", url: "saved" };
		repo.dependencies = [dependency, { ...dependency }];
		await db.batch(await replaceSnapshotStmts(db, account, kind, publication, now));
		if (kind !== "factory")
			await db
				.prepare("INSERT INTO factory_state(account_id,published_id,next_at) VALUES(?,'r1','t')")
				.bind(account)
				.run();
		const before = await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all();
		const policy = await repoPolicy(db, account, { repos: [{ name_with_owner: repo.name }] });
		const reader = createDb(raw);
		const result = await readObservation(reader, account, "factory", "all", policy);
		expect(result.data.repos).toMatchObject([{ dependencies: [dependency] }]);
		expect(reader.statements).toBe(2);
		expect(await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(before);
	},
);
