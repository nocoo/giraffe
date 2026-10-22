import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { github } from "../../../../../tests/fixtures/factory";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { createDb } from "./db/d1";
import { replaceSnapshotStmts } from "./db/snapshots";
import { exclusion } from "./factory-map";
import { readCiObservation, readObservation } from "./machine-observations";
import { readSources } from "./machine-sources";
import { prepareRefresh } from "./refresh";
import { factoryFreshness, repoPolicy, scopedSnapshot } from "./snapshot-projection";

it("selects starred-owned daily and all owned weekly without statistics overrides", async () => {
	const db = createDb(sqliteFixture());
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
			{
				repos: [
					{ name_with_owner: "Owner/app" },
					{ name_with_owner: "owner/archive", is_archived: true },
					{ name_with_owner: "owner/fork", is_fork: true },
					{ name_with_owner: "other/external" },
				],
			},
			"2026-10-22T00:00:00Z",
		),
	);
	await db
		.prepare(
			"INSERT INTO repo_stars(account_id,repo) VALUES('a','owner/app'),('a','owner/archive'),('a','other/external')",
		)
		.run();
	await db
		.prepare("INSERT INTO repo_statistics VALUES('a','owner/app',0),('a','owner/fork',1)")
		.run();
	const daily = await repoPolicy(db, "a", undefined, "starred");
	const weekly = await repoPolicy(db, "a", undefined, "all");
	expect(daily.repos.map((repo) => repo.name_with_owner)).toEqual(["Owner/app", "owner/archive"]);
	expect(weekly.repos.map((repo) => repo.name_with_owner)).toEqual([
		"Owner/app",
		"owner/archive",
		"owner/fork",
	]);
	expect(daily.includes("owner/app")).toBe(true);
	expect(daily.includes("owner/fork")).toBe(false);
	expect(weekly.includes("owner/fork")).toBe(true);
	expect(weekly.includes("other/external")).toBe(false);
	expect(
		exclusion(
			{ owner: { login: "owner" }, nameWithOwner: "owner/archive", isArchived: true },
			"owner",
		),
	).toBeNull();
});

it("migrates four explicit exclusions out of eighteen stars on a preserved backup copy idempotently", () => {
	const directory = mkdtempSync(join(tmpdir(), "giraffe-r2-migration-"));
	const originalFile = join(directory, "original.sqlite");
	const copyFile = join(directory, "backup.sqlite");
	const migration = readFileSync("migrations/0016_star_membership.sql", "utf8");
	const schema = readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8");
	const names = [
		...Array.from({ length: 17 }, (_, index) => `owner/repo-${String(index).padStart(2, "0")}`),
		"external/repo",
	];
	const original = new DatabaseSync(originalFile);
	original.exec(schema.slice(0, schema.indexOf(migration)));
	original.exec(
		"CREATE TABLE _test_marker(key TEXT PRIMARY KEY,value TEXT); INSERT INTO _test_marker VALUES('env','test'); INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t'),('b','other','fake','fake','t','t')",
	);
	for (const name of names)
		original.prepare("INSERT INTO repo_stars(account_id,repo) VALUES('a',?)").run(name);
	original.exec(
		"INSERT INTO repo_stars(account_id,repo) VALUES('b','owner/repo-00'); INSERT INTO repo_statistics VALUES('a','OWNER/REPO-00',0),('a','owner/repo-01',0),('a','owner/repo-02',0),('a','owner/repo-03',0),('a','owner/unstarred',1),('a','nocoo/rsshub',1),('a','nocoo/wiki',0)",
	);
	original
		.prepare("INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES('a','repos',?,'t')")
		.run(
			JSON.stringify({
				repos: [
					{ name_with_owner: "owner/repo-02", is_archived: true },
					{ name_with_owner: "owner/repo-03", is_archived: true },
					{ name_with_owner: "external/repo" },
				],
			}),
		);
	const originalStars = original.prepare("SELECT * FROM repo_stars ORDER BY account_id,repo").all();
	const originalOverrides = original.prepare("SELECT * FROM repo_statistics ORDER BY repo").all();
	const snapshots = original.prepare("SELECT * FROM snapshots").all();
	original.close();
	copyFileSync(originalFile, copyFile);
	const backup = new DatabaseSync(copyFile);
	const untouched = new DatabaseSync(originalFile, { readOnly: true });
	try {
		expect(backup.prepare("SELECT value FROM _test_marker WHERE key='env'").get()).toEqual({
			value: "test",
		});
		const affected = backup
			.prepare(
				"SELECT count(*) AS total FROM repo_stars s WHERE EXISTS (SELECT 1 FROM repo_statistics o WHERE o.account_id=s.account_id AND lower(o.repo)=lower(s.repo) AND o.enabled=0)",
			)
			.get();
		expect(affected).toEqual({ total: 4 });
		backup.exec(migration);
		const stars = () =>
			backup.prepare("SELECT repo FROM repo_stars WHERE account_id='a' ORDER BY repo").all();
		expect(stars()).toEqual(
			names
				.filter((name) => !names.slice(0, 4).includes(name))
				.sort()
				.map((repo) => ({ repo })),
		);
		expect(stars()).toHaveLength(14);
		expect(backup.prepare("SELECT repo FROM repo_stars WHERE account_id='b'").all()).toEqual([
			{ repo: "owner/repo-00" },
		]);
		expect(backup.prepare("SELECT count(*) AS total FROM repo_statistics").get()).toEqual({
			total: 0,
		});
		expect(backup.prepare("SELECT * FROM snapshots").all()).toEqual(snapshots);
		const first = backup.prepare("SELECT * FROM repo_stars ORDER BY account_id,repo").all();
		backup.exec(migration);
		expect(backup.prepare("SELECT * FROM repo_stars ORDER BY account_id,repo").all()).toEqual(
			first,
		);
		expect(backup.prepare("SELECT count(*) AS total FROM repo_statistics").get()).toEqual({
			total: 0,
		});
		expect(untouched.prepare("SELECT * FROM repo_stars ORDER BY account_id,repo").all()).toEqual(
			originalStars,
		);
		expect(untouched.prepare("SELECT * FROM repo_statistics ORDER BY repo").all()).toEqual(
			originalOverrides,
		);
		expect(untouched.prepare("SELECT value FROM _test_marker WHERE key='env'").get()).toEqual({
			value: "test",
		});
	} finally {
		backup.close();
		untouched.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("counts every selected owned catalog member, including unpublished and unsaved repositories", async () => {
	const db = createDb(sqliteFixture());
	const factory = factoryFixture();
	const account = factory.account_id;
	const at = factory.fetched_at;
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake','t','t')",
		)
		.bind(account)
		.run();
	const save = async (kind: string, data: Record<string, unknown>) =>
		db.batch(await replaceSnapshotStmts(db, account, kind, data, at));
	await save("repos", {
		repos: ["nocoo/app", "nocoo/missing", "nocoo/unstarred", "external/repo"].map(
			(name_with_owner) => ({ name_with_owner }),
		),
	});
	await db
		.prepare(
			"INSERT INTO repo_stars(account_id,repo) VALUES(?,'nocoo/app'),(?,'nocoo/missing'),(?,'external/repo')",
		)
		.bind(account, account, account)
		.run();
	const repo = factory.repos[0];
	if (!repo) throw new Error("missing fixture");
	repo.observation = {
		version: "v",
		source: "run",
		refreshedAt: at,
		metadataAt: at,
		window: factory.window,
	};
	await save("factory", factory);
	for (const [suffix, data] of [
		["actions", { runs: [] }],
		["releases", { releases: [] }],
		["details", { default_branch: "main" }],
	] as const)
		await save(`repo:nocoo/app:${suffix}`, data);
	await save("issues", { issues: [], repository_fetched_at: { "nocoo/app": at }, truncated: true });
	await save("repo:nocoo/app:issues", { issues: [] });
	for (const scope of ["all", "starred"] as const) {
		const policy = await repoPolicy(db, account, undefined, scope);
		const expected = { total: scope === "all" ? 3 : 2, missing: scope === "all" ? 2 : 1 };
		expect(factoryFreshness(factory, policy)).toMatchObject(expected);
		expect(await readObservation(db, account, "factory", scope)).toMatchObject({
			freshness: expected,
			truncated: true,
		});
		expect(await readCiObservation(db, account, policy)).toMatchObject({ freshness: expected });
		expect(await scopedSnapshot(db, account, "insights", { fetched_at: at }, scope)).toMatchObject({
			freshness: expected,
		});
		expect(await readObservation(db, account, "repos", scope)).toMatchObject({
			freshness: { total: expected.total, missing: 0 },
		});
		if (scope === "all")
			expect(
				(await readSources(db, account, {})).sources.find(
					(source) => source.resource === "account:factory",
				),
			).toMatchObject({ freshness: expected, truncated: true });
	}
});

it("keeps nonowned repositories out of legacy aggregate and explicit refresh requests", async () => {
	const db = createDb(sqliteFixture());
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
			{
				repos: [
					{ name_with_owner: "owner/archive", is_archived: true },
					{ name_with_owner: "owner/fork", is_fork: true },
					{ name_with_owner: "external/repo" },
				],
			},
			"2026-10-22T00:00:00Z",
		),
	);
	const queries: string[] = [];
	const gh = github((_url, init) => {
		queries.push(String(JSON.parse(String(init?.body)).variables.q));
		return Response.json({
			data: { search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } } },
		});
	});
	await prepareRefresh(
		db,
		"a",
		gh,
		"fake",
		["issues"],
		"2026-10-22T00:00:00Z",
		{},
		{ deriveInsights: false },
	);
	expect(queries.join(" ")).toContain("repo:owner/archive");
	expect(queries.join(" ")).toContain("repo:owner/fork");
	expect(queries.join(" ")).not.toContain("external/repo");
	const calls = queries.length;
	await expect(
		prepareRefresh(db, "a", gh, "fake", ["repo:external/repo:details"], "2026-10-22T00:00:00Z"),
	).rejects.toMatchObject({ code: "validation_failed" });
	expect(queries).toHaveLength(calls);
});
