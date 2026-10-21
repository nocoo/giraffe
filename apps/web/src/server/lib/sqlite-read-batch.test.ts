import { expect, it } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";

it("returns SELECT results from the local D1 batch fixture in statement order", async () => {
	const raw = sqliteFixture();
	const rows = await raw.batch<{ value: number }>([
		raw.prepare("SELECT ? AS value").bind(1),
		raw.prepare("WITH number AS (SELECT ? AS value) SELECT value FROM number").bind(2),
	]);
	expect(rows.map((row) => row.results)).toEqual([[{ value: 1 }], [{ value: 2 }]]);
});
