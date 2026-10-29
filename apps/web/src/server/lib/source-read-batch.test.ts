import { expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { profileDb } from "../../../../../tests/fixtures/profile-db";
import { sourcesFixture } from "../../../../../tests/fixtures/sources";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { createDb } from "./db/d1";
import { readSources } from "./machine-sources";
import { SourceTiming } from "./source-timing";

it("profiles a read-only SELECT batch as one round trip while retaining each statement", async () => {
	const profile = profileDb(sqliteFixture());
	const result = await profile.raw.batch([
		profile.raw.prepare("SELECT 1 AS value"),
		profile.raw.prepare("SELECT 2 AS value"),
	]);
	expect(result.map((row) => row.results)).toEqual([[{ value: 1 }], [{ value: 2 }]]);
	expect(profile.queries).toHaveLength(2);
	expect(profile.trips).toHaveLength(1);
	expect(() => profile.raw.prepare("DELETE FROM refresh_snapshots").run()).toThrow();
	await expect(
		profile.raw.batch([profile.raw.prepare("DELETE FROM refresh_snapshots")]),
	).rejects.toThrow();
});

it("reads the complete source index with one reader D1 round trip and seven read-only statements", async () => {
	const fixture = await sourcesFixture();
	const profile = profileDb(fixture.raw);
	const result = await readSources(createDb(profile.raw), fixture.account, {});
	expect(result.repositories).toEqual(fixture.names);
	expect(result.sources).toHaveLength(1518);
	expect(profile.queries).toHaveLength(7);
	expect(profile.trips).toHaveLength(1);
});

it.each([
	{ repository: "FIXTURE/PROJECT-001" },
	{ since: "2026-10-19T00:00:00Z" },
	{ since: "2099-01-01T00:00:00Z" },
])("retains one batch and identical output with timing for %j", async (query) => {
	const fixture = await sourcesFixture();
	const expected = await readSources(createDb(fixture.raw), fixture.account, query);
	const profile = profileDb(fixture.raw);
	const timing = new SourceTiming();
	expect(await readSources(createDb(profile.raw), fixture.account, query, timing)).toEqual(
		expected,
	);
	expect(profile.trips).toHaveLength(1);
	expect(timing.header()).toMatch(/decode;dur=\d+\.\d{2}/);
	expect(timing.header()).toMatch(/hash;dur=\d+\.\d{2}/);
});

it("rejects malformed filters without a trip and incomplete batch responses without a false empty success", async () => {
	const raw = sqliteFixture();
	const profile = profileDb(raw);
	await expect(readSources(createDb(profile.raw), "a", { since: "invalid" })).rejects.toMatchObject(
		{
			status: 400,
		},
	);
	expect(profile.trips).toEqual([]);
	vi.spyOn(raw, "batch").mockResolvedValueOnce([]);
	await expect(readSources(createDb(raw), "a", {})).rejects.toMatchObject({ code: "db_error" });
	await expect(profile.raw.batch([raw.prepare("SELECT 1")])).rejects.toThrow("owned statements");
});

it("ignores orphan canonical publication pages and retired heads", async () => {
	const fixture = await sourcesFixture();
	await fixture.raw.prepare("DELETE FROM refresh_publications").run();
	await fixture.raw.prepare("DELETE FROM refresh_snapshots WHERE kind='factory'").run();
	const publication = factoryFixture();
	await fixture.save("factory#2", publication);
	await fixture.raw
		.prepare("INSERT INTO factory_state(account_id,published_id,next_at) VALUES(?,'retired','t')")
		.bind(fixture.account)
		.run();
	const result = await readSources(createDb(fixture.raw), fixture.account, {});
	expect(result.sources.some((source) => source.resource.includes("factory"))).toBe(false);
});
