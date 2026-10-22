import { expect, it } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import { createDb } from "./db/d1";
import { startRun } from "./db/factory-runs";

it("R4 persisted predecessor selection preserves pre-migration success and ignores selected/weekly/deep runs", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	const now = "2026-10-22T20:00:00.000Z";
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','nocoo','fake','fake',?,?)",
		)
		.bind(now, now)
		.run();
	const previous = makeRun(
		"previous",
		"a",
		"nocoo",
		"previous",
		"refresh",
		[],
		"2026-10-21T19:00:00.000Z",
		[],
		[],
		{ scope: "all" },
		"quick",
	);
	previous.status = "completed";
	for (const [id, kind, scope, depth, status] of [
		["previous", "daily", "all", "quick", "completed"],
		["selected", "manual", "selected", "quick", "completed"],
		["weekly", "weekly", "all", "quick", "completed"],
		["deep", "daily", "all", "deep", "completed"],
		["excluded-failure", "manual", "selected", "quick", "failed"],
	] as const) {
		const run = { ...previous, id, trigger: kind, selection: { scope }, depth, status };
		if (id !== "previous") run.window = { ...run.window, until: "2026-10-22T10:00:00.000Z" };
		await db
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,'a',?,?,?,?,?,?)",
			)
			.bind(id, id, status, JSON.stringify(run), run.startedAt, run.startedAt, run.startedAt)
			.run();
	}
	const current = makeRun(
		"current",
		"a",
		"nocoo",
		"current",
		"refresh",
		[],
		now,
		[],
		[],
		{ scope: "all" },
		"quick",
	);
	const saved = await startRun(db, current);
	expect(saved.previousActivityRunId).toBe("previous");
	expect(saved.activityWindow).toEqual({
		since: previous.window.until,
		until: now,
		gap: false,
		first: false,
	});
});
it.each(["failed", "cancelled", "partial"] as const)(
	"R4 stretches past an interrupted eligible %s run and marks the gap",
	async (status) => {
		const raw = sqliteFixture();
		const db = createDb(raw);
		const now = "2026-10-22T20:00:00.000Z";
		await db
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','nocoo','fake','fake',?,?)",
			)
			.bind(now, now)
			.run();
		const previous = makeRun(
			"previous",
			"a",
			"nocoo",
			"previous",
			"refresh",
			[],
			"2026-10-20T20:00:00.000Z",
			[],
			[],
			{ scope: "all" },
			"quick",
		);
		const interrupted = makeRun(
			"interrupted",
			"a",
			"nocoo",
			"interrupted",
			"refresh",
			[],
			"2026-10-21T20:00:00.000Z",
			[],
			[],
			{ scope: "all" },
			"quick",
		);
		for (const [run, state] of [
			[previous, "completed"],
			[interrupted, status],
		] as const)
			await db
				.prepare(
					"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,'a',?,?,?,?,?,?)",
				)
				.bind(
					run.id,
					run.id,
					state,
					JSON.stringify({ ...run, status: state }),
					run.startedAt,
					run.startedAt,
					run.startedAt,
				)
				.run();
		const current = makeRun(
			"current",
			"a",
			"nocoo",
			"current",
			"refresh",
			[],
			now,
			[],
			[],
			{ scope: "selected" },
			"quick",
			true,
		);
		current.trigger = "daily";
		const saved = await startRun(db, current);
		expect(saved.previousActivityRunId).toBe("previous");
		expect(saved.activityWindow).toMatchObject({
			since: previous.window.until,
			until: now,
			gap: true,
			first: false,
		});
	},
);
it("R4 predecessor selection is atomic with admission when an active predecessor publishes in between", async () => {
	const { vi } = await import("vitest");
	const raw = sqliteFixture();
	const db = createDb(raw);
	const now = "2026-10-22T20:00:00.000Z";
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','nocoo','fake','fake',?,?)",
		)
		.bind(now, now)
		.run();
	const old = makeRun(
		"r0",
		"a",
		"nocoo",
		"r0",
		"refresh",
		[],
		"2026-10-21T20:00:00.000Z",
		[],
		[],
		{ scope: "all" },
		"quick",
	);
	const preceding = makeRun(
		"r1",
		"a",
		"nocoo",
		"r1",
		"refresh",
		[],
		"2026-10-22T19:55:00.000Z",
		[],
		[],
		{ scope: "all" },
		"quick",
	);
	for (const [run, status] of [
		[old, "completed"],
		[preceding, "running"],
	] as const)
		await db
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,'a',?,?,?,?,?,?)",
			)
			.bind(
				run.id,
				run.id,
				status,
				JSON.stringify({ ...run, status }),
				run.startedAt,
				run.startedAt,
				run.startedAt,
			)
			.run();
	const batch = db.batch.bind(db);
	vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
		await raw
			.prepare("UPDATE factory_runs SET status='completed',payload=? WHERE id='r1'")
			.bind(JSON.stringify({ ...preceding, status: "completed" }))
			.run();
		return batch(statements);
	});
	const current = makeRun(
		"r2",
		"a",
		"nocoo",
		"r2",
		"refresh",
		[],
		now,
		[],
		[],
		{ scope: "all" },
		"quick",
	);
	const admitted = await startRun(db, current);
	expect(admitted.previousActivityRunId).toBe("r1");
	expect(admitted.activityWindow?.since).toBe(preceding.window.until);
});
