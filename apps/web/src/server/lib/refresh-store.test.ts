import { expect, it } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { createDb } from "./db/d1";
import { parseRefreshParams } from "./refresh-params";
import {
	activeRefreshRun,
	addRefreshPartialReasons,
	addRefreshRequests,
	cancelRefreshRun,
	createRefreshRun,
	emptyRequestBreakdown,
	getRefreshRun,
	listRefreshRuns,
	saveRefreshRun,
	scheduledRefreshRun,
	terminalRefreshStatus,
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
it("initializes the request breakdown, reasons and cancel intent on new runs", async () => {
	const db = await fixture();
	const run = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date("2026-10-29T01:00:00.000Z")),
		"manual",
		"2026-10-29T01:00:00.000Z",
	);
	expect(run).toMatchObject({
		requests: 0,
		requestBreakdown: emptyRequestBreakdown(),
		partialReasons: [],
		cancelRequested: false,
	});
	expect(emptyRequestBreakdown()).toEqual({
		total: 0,
		graphql: 0,
		rest: 0,
		a: { graphql: 0, rest: 0 },
		b: { graphql: 0, rest: 0 },
	});
});
it("accumulates transport counts per phase while keeping the legacy total", async () => {
	const db = await fixture();
	let run = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date("2026-10-29T01:00:00.000Z")),
		"manual",
		"2026-10-29T01:00:00.000Z",
	);
	run = addRefreshRequests(run, "a", { graphql: 2, rest: 1 });
	run = addRefreshRequests(run, "b", { graphql: 1, rest: 2 });
	run = addRefreshRequests(run, "b", { graphql: 0, rest: 4 });
	expect(run.requests).toBe(10);
	expect(run.requestBreakdown).toEqual({
		total: 10,
		graphql: 3,
		rest: 7,
		a: { graphql: 2, rest: 1 },
		b: { graphql: 1, rest: 6 },
	});
});
it("attributes partial reasons to the account or a single repository without duplicates", async () => {
	const db = await fixture();
	let run = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date("2026-10-29T01:00:00.000Z")),
		"manual",
		"2026-10-29T01:00:00.000Z",
	);
	run = addRefreshPartialReasons({ ...run, partial: true }, null, [
		"contributions:unavailable",
		"catalog:incomplete",
	]);
	run = addRefreshPartialReasons(run, "octo/one", ["prs:inventory_incomplete"]);
	run = addRefreshPartialReasons(run, "octo/one", [
		"prs:inventory_incomplete",
		"issues:unavailable",
	]);
	run = addRefreshPartialReasons(run, null, ["catalog:incomplete"]);
	expect(run.partialReasons).toEqual([
		{ repo: null, codes: ["catalog:incomplete", "contributions:unavailable"] },
		{ repo: "octo/one", codes: ["issues:unavailable", "prs:inventory_incomplete"] },
	]);
	expect(addRefreshPartialReasons(run, "octo/two", [])).toBe(run);
});
it("marks queued and running runs cancelled once and never mutates terminal runs", async () => {
	const db = await fixture();
	const queued = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date("2026-10-29T01:00:00.000Z")),
		"manual",
		"2026-10-29T01:00:00.000Z",
	);
	const cancelled = cancelRefreshRun(queued, "2026-10-29T01:05:00.000Z");
	expect(cancelled).toMatchObject({
		status: "cancelled",
		phase: "done",
		cancelRequested: true,
		updatedAt: "2026-10-29T01:05:00.000Z",
		finishedAt: "2026-10-29T01:05:00.000Z",
	});
	expect(cancelRefreshRun(cancelled, "2026-10-29T02:00:00.000Z")).toBe(cancelled);
	await saveRefreshRun(db, { ...cancelled, status: "cancelled" });
	expect(await activeRefreshRun(db, "account")).toBeNull();
	expect((await listRefreshRuns(db, "account"))[0]?.status).toBe("cancelled");
	expect(terminalRefreshStatus("queued")).toBe(false);
	expect(terminalRefreshStatus("running")).toBe(false);
	for (const status of ["completed", "partial", "failed", "cancelled"] as const)
		expect(terminalRefreshStatus(status)).toBe(true);
});
