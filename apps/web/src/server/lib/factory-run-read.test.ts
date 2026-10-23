import { expect, it, vi } from "vitest";
import { profileDb } from "../../../../../tests/fixtures/profile-db";
import { sourcesFixture } from "../../../../../tests/fixtures/sources";
import { makeRun } from "../../lib/factory-run";
import { createDb } from "./db/d1";
import { catalogFactory, factoryHead, listRuns, repoStates } from "./db/factory-runs";
import { factoryStorage } from "./factory-retention";
import { readFactoryRunInputs } from "./factory-run-read";
import { siteCatalog } from "./factory-site";
import { readRunEstimates } from "./run-estimates";
import { projectFactory, repoPolicy } from "./snapshot-projection";

it("preserves catalog head and legacy fallback projections in one read batch", async () => {
	const fixture = await sourcesFixture();
	const db = createDb(fixture.raw);
	await fixture.save("factory", { ...fixture.snapshot });
	await fixture.save("factory:catalog:catalog-view", { ...fixture.snapshot });
	for (const catalogId of [null, "", "catalog-view", "missing-catalog"]) {
		await fixture.raw
			.prepare("UPDATE factory_state SET catalog_id=? WHERE account_id=?")
			.bind(catalogId, fixture.account)
			.run();
		const profile = profileDb(fixture.raw);
		const actual = await readFactoryRunInputs(createDb(profile.raw), fixture.account, "");
		const reference = createDb(fixture.raw);
		const policy = await repoPolicy(reference, fixture.account);
		const catalog = await catalogFactory(reference, fixture.account);
		expect(actual.catalog).toEqual(catalog ? projectFactory(catalog, policy) : null);
		expect(actual.siteRepos).toEqual(await siteCatalog(reference, fixture.account));
		expect(actual.head).toEqual(await factoryHead(reference, fixture.account));
		expect(actual.runs).toEqual(await listRuns(reference, fixture.account));
		expect(actual.calibration).toEqual(await readRunEstimates(reference, fixture.account));
		expect(actual.states).toEqual(await repoStates(reference, fixture.account));
		expect(actual.storage).toEqual(await factoryStorage(reference, fixture.account));
		expect(profile.trips).toHaveLength(1);
		expect(profile.queries).toHaveLength(10);
	}
	await fixture.raw
		.prepare("DELETE FROM factory_state WHERE account_id=?")
		.bind(fixture.account)
		.run();
	const actual = await readFactoryRunInputs(db, fixture.account, "");
	const legacy = await catalogFactory(db, fixture.account);
	expect(actual.catalog).toEqual(legacy ? projectFactory(legacy, actual.policy) : null);
	for (const repos of [
		[],
		[{ name_with_owner: "bad" }],
		[{ name_with_owner: "fixture/app" }, { name_with_owner: "fixture/app" }],
	]) {
		await fixture.raw
			.prepare("DELETE FROM snapshots WHERE account_id=? AND kind='repos'")
			.bind(fixture.account)
			.run();
		await fixture.save("repos", { repos });
		const data = await readFactoryRunInputs(db, fixture.account, "");
		expect(data.siteRepos).toEqual(await siteCatalog(db, fixture.account));
	}
});

it("rejects incomplete run batches rather than inventing empty state", async () => {
	const fixture = await sourcesFixture();
	const db = createDb(fixture.raw);
	const execute = db.batch.bind(db);
	const batch = vi.spyOn(db, "batch");
	batch.mockResolvedValueOnce([]);
	await expect(readFactoryRunInputs(db, fixture.account, "")).rejects.toMatchObject({
		code: "db_error",
	});
	batch.mockImplementationOnce(async (statements) => {
		const results = await execute(statements);
		delete results[4];
		return results;
	});
	await expect(readFactoryRunInputs(db, fixture.account, "")).rejects.toMatchObject({
		code: "db_error",
	});
});

it("includes finished partial refresh history in the batched ETA calibration", async () => {
	const fixture = await sourcesFixture();
	const at = "2026-10-22T00:00:00.000Z";
	for (const duration of [1000, 3000]) {
		const run = {
			...makeRun(
				`partial-${duration}`,
				fixture.account,
				"fixture",
				`key-${duration}`,
				"refresh",
				[],
				at,
			),
			status: "partial",
			finishedAt: new Date(Date.parse(at) + duration).toISOString(),
		};
		await fixture.raw
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
			)
			.bind(run.id, fixture.account, run.requestKey, run.status, JSON.stringify(run), at, at, at)
			.run();
	}
	const profile = profileDb(fixture.raw);
	const result = await readFactoryRunInputs(createDb(profile.raw), fixture.account, "");
	expect(result.calibration).toEqual({
		catalog: null,
		quick: null,
		deep: 250,
		plans: {
			"partial-1000": [
				["snapshot", 6, 6, null],
				["contributions", 1, 1, null],
				["publish", 1, 1, null],
			],
			"partial-3000": [
				["snapshot", 6, 6, null],
				["contributions", 1, 1, null],
				["publish", 1, 1, null],
			],
		},
	});
	expect(profile.trips).toHaveLength(1);
});
