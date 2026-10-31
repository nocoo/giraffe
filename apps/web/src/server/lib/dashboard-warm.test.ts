import { expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { savedObservationStmts } from "../../../../../tests/fixtures/refresh";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { warmDashboardResponsesAfterPublishSafely } from "./dashboard-warm";
import * as warmRun from "./dashboard-warm-run";
import { createDb } from "./db/d1";

async function seed(db: ReturnType<typeof createDb>, account = "a") {
	await db.batch(
		await savedObservationStmts(
			db,
			account,
			"factory",
			factoryFixture(),
			"2026-10-22T00:00:00.000Z",
		),
	);
	await db.batch(
		await savedObservationStmts(
			db,
			account,
			"repos",
			{
				repos: factoryFixture().repos.map((repo) => ({
					id: repo.id,
					name_with_owner: repo.name,
				})),
			},
			"2026-10-22T00:00:00.000Z",
		),
	);
}

it("warmDashboardResponsesAfterPublishSafely absorbs warm failures", async () => {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES('a','nocoo','fake','fake',1,'2026-10-22','2026-10-22')",
		)
		.run();
	const db = createDb(raw);
	await seed(db);
	const warmSpy = vi
		.spyOn(warmRun, "warmDashboardResponsesAfterPublish")
		.mockRejectedValue(new Error("warm failed"));
	const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		await expect(warmDashboardResponsesAfterPublishSafely(db, "a")).resolves.toBeUndefined();
		expect(warmSpy).toHaveBeenCalledWith(db, "a");
		expect(
			warnSpy.mock.calls.some(([message]) =>
				String(message).includes("dashboard warm after publish failed for a"),
			),
		).toBe(true);
	} finally {
		warmSpy.mockRestore();
		warnSpy.mockRestore();
	}
});
