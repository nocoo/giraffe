import { expect, it } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { FactorySnapshot } from "../../lib/factory-types";
import { createDb } from "./db/d1";
import { latestFactoryRate, readFactoryRate } from "./factory-rate";

const now = Date.parse("2026-10-21T06:00:00Z");
const rate = {
	remaining: 100,
	resetAt: "2026-10-21T07:00:00Z",
	resource: "core",
	observedAt: "2026-10-21T05:59:00Z",
};

it("orders observations by their own timestamp, not reset deadlines or publication times", () => {
	const older = {
		...rate,
		remaining: 200,
		observedAt: "2026-10-21T13:58:00+08:00",
		resetAt: "2999-01-01T00:00:00Z",
	};
	expect(latestFactoryRate(older, rate, null)).toEqual(rate);
	expect(latestFactoryRate(rate, older)).toEqual(rate);
	expect(latestFactoryRate({ ...older, observedAt: "invalid" }, null)).toBeNull();
});

it("rejects invalid, expired and undated observations without falling back to older quotas", async () => {
	const db = createDb(sqliteFixture());
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t')",
		)
		.run();
	const invalid: FactorySnapshot["rate"][] = [
		null,
		{ remaining: 100, resetAt: rate.resetAt, resource: "core" },
		{ ...rate, observedAt: "invalid" },
		{ ...rate, observedAt: "2026-10-21T08:00:00Z" },
		{ ...rate, remaining: -1 },
		{ ...rate, remaining: Number.NaN },
		{ ...rate, remaining: 1.5 },
		{ ...rate, resource: "" },
		{ ...rate, resetAt: null },
		{ ...rate, resetAt: "invalid" },
		{ ...rate, resetAt: "2026-10-21T06:00:00Z" },
	];
	for (const candidate of invalid)
		expect(await readFactoryRate(db, "a", candidate, now)).toBeNull();
	expect(await readFactoryRate(db, "a", rate, now)).toEqual(rate);
	const stale = { ...rate, observedAt: "2026-10-21T05:59:30Z", resetAt: "2026-10-21T05:59:59Z" };
	await db
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('r','a','k','paused',?,'t','t','t')",
		)
		.bind(JSON.stringify({ checkpoint: { rate: stale } }))
		.run();
	const before = db.statements;
	expect(await readFactoryRate(db, "a", rate, now)).toBeNull();
	expect(db.statements - before).toBe(1);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('b','other','fake','fake','t','t')",
		)
		.run();
	expect(await readFactoryRate(db, "b", rate, now)).toEqual(rate);
});
