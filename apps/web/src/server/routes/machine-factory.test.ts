import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import type { Env } from "../env";
import { createApp } from "../index";
import { createApiToken } from "../lib/api-tokens";
import { createDb } from "../lib/db/d1";
import { replaceSnapshotStmts } from "../lib/db/snapshots";
import type { readFactoryResource } from "../lib/machine-observations";
import type { readSources } from "../lib/machine-sources";

async function fixture(retained: boolean, status: "complete" | "limited") {
	const raw = sqliteFixture();
	const db = createDb(raw);
	const snapshot = factoryFixture();
	const account = snapshot.account_id;
	const repository = snapshot.repos[0];
	if (!repository) throw new Error("missing fixture repository");
	const originalAt = snapshot.fetched_at;
	const currentAt = "2026-10-23T00:00:00.000Z";
	snapshot.runId = "current";
	snapshot.fetched_at = currentAt;
	snapshot.status = "complete";
	snapshot.publication = { runId: "current", mixed: retained, publishedAt: currentAt };
	repository.observation = {
		version: "current",
		refreshedAt: currentAt,
		window: { ...snapshot.window, until: currentAt },
		source: "run",
	};
	for (const stream of FACTORY_STREAMS)
		Object.assign(repository.coverage[stream], { status: "complete", fetchedAt: currentAt });
	const coverage = repository.coverage.dependencies;
	Object.assign(coverage, {
		status,
		fetchedAt: retained ? originalAt : currentAt,
		...(status === "limited" ? { reason_code: "dependency_parse_unsupported" } : {}),
		...(retained
			? {
					retained: true,
					observation: {
						...repository.observation,
						head: repository.head,
						version: "original",
						refreshedAt: originalAt,
						window: snapshot.window,
					},
				}
			: {}),
	});
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake','t','t')",
		)
		.bind(account)
		.run();
	const save = async (kind: string, data: Record<string, unknown>) =>
		db.batch(await replaceSnapshotStmts(db, account, kind, data, currentAt));
	await save("repos", { repos: [{ name_with_owner: repository.name }] });
	await save("factory:v:current", snapshot);
	await db
		.prepare("INSERT INTO factory_state(account_id,published_id,next_at) VALUES(?,'current','t')")
		.bind(account)
		.run();
	await db
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('current',?,'key','partial','{}','t','t','t')",
		)
		.bind(account)
		.run();
	await db
		.prepare("INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES('current',?,?,?)")
		.bind(
			repository.name,
			retained ? "retained:dependencies" : "dependencies",
			JSON.stringify({
				runId: retained ? "original" : "current",
				items: [],
				ranges: [],
				next: null,
				coverage: retained ? { ...coverage, status: "complete" } : coverage,
			}),
		)
		.run();
	const token = await createApiToken(db, {
		accountId: account,
		label: "fixture",
		scopes: ["observations:read"],
		expiresInDays: 1,
		creator: "test@local",
	});
	const app = createApp();
	const get = async <Result>(path: string) => {
		const response = await app.request(
			`http://localhost/api/v1/accounts/${account}/${path}`,
			{ headers: { Authorization: `Bearer ${token.token}` } },
			{ DB: raw, ENVIRONMENT: "development" } as Env,
		);
		expect(response.status).toBe(200);
		return response.json() as Promise<Result>;
	};
	return { db, snapshot, repository, save, get, originalAt, currentAt };
}

it.each([
	[true, "limited", 1],
	[true, "complete", 0],
	[false, "complete", 0],
	[false, "limited", 1],
] as const)(
	"shares factory freshness across endpoints (retained=%s, status=%s)",
	async (retained, status, missing) => {
		const setup = await fixture(retained, status);
		const indexed = await setup.get<Awaited<ReturnType<typeof readSources>>>("sources");
		const source = indexed.sources.find(
			(row: { resource: string }) => row.resource === "factory:nocoo/app:dependencies",
		);
		const stream = await setup.get<Awaited<ReturnType<typeof readFactoryResource>>>(
			"factory/repos/nocoo/app/dependencies",
		);
		const observedAt = retained ? setup.originalAt : setup.currentAt;
		const freshness = { oldestAt: observedAt, latestAt: observedAt, total: 1, missing };
		expect(source?.freshness).toEqual(freshness);
		expect(stream.freshness).toEqual(freshness);
		expect(stream.coverage).toEqual(source?.coverage);
		expect(stream.truncated).toBe(status === "limited");
		expect(stream.unavailable).toBe(false);
		expect(stream.sourceVersion).toBe(retained ? "original" : "current");
		expect(source?.observedAt).toBe(observedAt);
	},
);

type Retention = { any: boolean; streams: string[] } | null;
type RepositoryList = { data: { repos: { name_with_owner: string; retained: Retention }[] } };
type FactoryList = { data: { repos: { name: string; retained: Retention }[] } };

it.each([
	[true, "limited"],
	[true, "complete"],
	[false, "complete"],
	[false, "limited"],
] as const)(
	"summarizes only published retained streams (retained=%s, status=%s)",
	async (retained, status) => {
		const setup = await fixture(retained, status);
		await setup.save("repos", {
			repos: [{ name_with_owner: "nocoo/app" }, { name_with_owner: "nocoo/empty" }],
		});
		const before = await setup.db.prepare("SELECT * FROM snapshots ORDER BY kind").all();
		const repositories = await setup.get<RepositoryList>("repos");
		const factory = await setup.get<FactoryList>("factory");
		const expected = { any: retained, streams: retained ? ["dependencies"] : [] };
		expect(repositories.data.repos).toMatchObject([
			{ name_with_owner: "nocoo/app", retained: expected },
			{ name_with_owner: "nocoo/empty", retained: null },
		]);
		expect(factory.data.repos).toMatchObject([{ name: "nocoo/app", retained: expected }]);
		expect(factory.data.repos).toHaveLength(1);
		expect(await setup.db.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(before);
		await setup.db.prepare("UPDATE factory_runs SET status='failed',payload='{}'").run();
		expect(await setup.get<RepositoryList>("repos")).toEqual(repositories);
		expect(await setup.get<FactoryList>("factory")).toEqual(factory);
	},
);

it("leaves repository retention unknown without a factory publication", async () => {
	const setup = await fixture(true, "limited");
	await setup.db.prepare("DELETE FROM factory_state").run();
	await setup.db.prepare("DELETE FROM snapshots WHERE kind LIKE 'factory:%'").run();
	const repositories = await setup.get<RepositoryList>("repos");
	expect(repositories.data.repos).toMatchObject([{ name_with_owner: "nocoo/app", retained: null }]);
});

it("orders multiple retained streams and matches catalog casing without changing catalog versions", async () => {
	const setup = await fixture(true, "limited");
	const before = await setup.get<
		RepositoryList & { sourceVersion: string; contentVersion: string }
	>("repos");
	setup.repository.name = "NOCOO/APP";
	setup.repository.coverage.commits.retained = true;
	await setup.save("factory:v:current", setup.snapshot);
	const repositories = await setup.get<typeof before>("repos");
	const factory = await setup.get<FactoryList>("factory");
	const expected = { any: true, streams: ["commits", "dependencies"] };
	expect(repositories.data.repos[0]?.retained).toEqual(expected);
	expect(factory.data.repos[0]?.retained).toEqual(expected);
	expect(repositories.sourceVersion).toBe(before.sourceVersion);
	expect(repositories.contentVersion).toBe(before.contentVersion);
});
