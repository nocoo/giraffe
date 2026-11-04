import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { savedObservationStmts } from "../../../../../tests/fixtures/refresh";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { createDb } from "./db/d1";
import { readContributions } from "./machine-contributions";

async function seedCalendar(days: Array<{ date: string; count: number }>) {
	const raw = sqliteFixture();
	const db = createDb(raw);
	const snapshot = factoryFixture();
	const account = snapshot.account_id;
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'owner','fake','fake','old','old')",
		)
		.bind(account)
		.run();
	snapshot.contribution = {
		days,
		total: days.reduce((sum, day) => sum + day.count, 0),
		restricted: 0,
		fetchedAt: "2026-11-03T03:00:00.000Z",
	};
	snapshot.contributionStatus = "complete";
	await db.batch(
		await savedObservationStmts(db, account, "factory", snapshot, snapshot.fetched_at),
	);
	return { db, account };
}

it("returns contributions_calendar_stale when the requested until date is past the saved calendar", async () => {
	const { db, account } = await seedCalendar([
		{ date: "2026-11-02", count: 174 },
		{ date: "2026-11-03", count: 394 },
	]);
	await expect(
		readContributions(db, account, { since: ["2026-11-04"], until: ["2026-11-04"] }),
	).rejects.toMatchObject({
		status: 400,
		code: "contributions_calendar_stale",
		details: { lastSavedDate: "2026-11-03" },
	});
});

it("still rejects ranges before the saved calendar with validation_failed", async () => {
	const { db, account } = await seedCalendar([{ date: "2026-11-03", count: 394 }]);
	await expect(
		readContributions(db, account, { since: ["2026-01-01"], until: ["2026-11-03"] }),
	).rejects.toMatchObject({
		status: 400,
		code: "validation_failed",
		message: "contribution range exceeds saved dates",
	});
});
