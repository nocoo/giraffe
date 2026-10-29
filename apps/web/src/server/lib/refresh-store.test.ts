import { expect, it } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { createDb } from "./db/d1";
import { parseRefreshParams } from "./refresh-params";
import {
	activeRefreshRun,
	createRefreshRun,
	getRefreshRun,
	listRefreshRuns,
	saveRefreshRun,
	scheduledRefreshRun,
} from "./refresh-store";

async function fixture() {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('account','octo','fake','fake','t','t'),('other','other','fake','fake','t','t')",
		)
		.run();
	return createDb(raw);
}
it("stores UTC runs, fences accounts, and only permits one active run", async () => {
	const db = await fixture();
	const now = "2026-10-29T01:00:00.000Z";
	const params = parseRefreshParams({}, new Date(now));
	expect(await activeRefreshRun(db, "account")).toBeNull();
	const run = await createRefreshRun(db, "account", params, "manual", now);
	expect(run.status).toBe("queued");
	expect(await getRefreshRun(db, "other", run.id)).toBeNull();
	expect(await activeRefreshRun(db, "account")).toEqual(run);
	await saveRefreshRun(db, { ...run, status: "running" });
	const queued = await createRefreshRun(db, "account", params, "manual", now);
	await expect(saveRefreshRun(db, { ...queued, status: "running" })).rejects.toThrow();
	await saveRefreshRun(db, { ...queued, status: "failed" });
	await saveRefreshRun(db, { ...run, status: "completed", phase: "done", finishedAt: now });
	expect(await activeRefreshRun(db, "account")).toBeNull();
	expect((await listRefreshRuns(db, "account")).find((item) => item.id === run.id)?.status).toBe(
		"completed",
	);
	expect(await listRefreshRuns(db, "other")).toEqual([]);
});
it("deduplicates the Shanghai scheduled day and orders a bounded history", async () => {
	const db = await fixture();
	const now = "2026-10-28T19:00:00.000Z";
	const params = parseRefreshParams({}, new Date(now));
	expect(await scheduledRefreshRun(db, "account", "2026-10-29")).toBeNull();
	const run = await createRefreshRun(db, "account", params, "scheduled", now, "2026-10-29");
	await saveRefreshRun(db, { ...run, status: "failed", errorCode: "github_error" });
	expect(await scheduledRefreshRun(db, "account", "2026-10-29")).toMatchObject({
		id: run.id,
		status: "failed",
	});
	await expect(
		createRefreshRun(db, "account", params, "scheduled", now, "2026-10-29"),
	).rejects.toThrow();
	const next = await createRefreshRun(db, "account", params, "manual", "2026-10-29T02:00:00.000Z");
	expect((await listRefreshRuns(db, "account"))[0]?.id).toBe(next.id);
});
