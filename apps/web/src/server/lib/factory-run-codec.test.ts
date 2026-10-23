import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import { decodeRun, encodeRun } from "./factory-run-codec";

it("compacts default step fields without changing the public run", () => {
	const snapshot = factoryFixture();
	const run = makeRun("run", "a", "nocoo", "key", "refresh", snapshot.repos, snapshot.fetched_at);
	const encoded = encodeRun(run);
	expect(encoded.length).toBeLessThan(JSON.stringify(run).length * 0.8);
	expect(decodeRun(encoded)).toEqual(run);
	expect(decodeRun(JSON.stringify(run))).toEqual(run);
	const step = run.steps[0];
	if (!step) throw new Error("fixture");
	Object.assign(step, {
		status: "failed",
		attempts: 3,
		pages: 2,
		durationMs: 500,
		error: "github_error",
		retryFailures: 3,
		startedAt: run.startedAt,
		finishedAt: run.startedAt,
	});
	expect(decodeRun(encodeRun(run))).toEqual(run);
});

it("expands a backup to the old reader's required numeric and nullable fields before rollback", async () => {
	const snapshot = factoryFixture();
	const run = makeRun("run", "a", "nocoo", "key", "refresh", snapshot.repos, snapshot.fetched_at);
	run.status = "cancelled";
	Object.assign(run.steps[0] ?? {}, {
		status: "success",
		attempts: 2,
		pages: 3,
		durationMs: 400,
		startedAt: run.startedAt,
		finishedAt: run.startedAt,
	});
	const db = sqliteFixture();
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','fixture','fake','fake',?,?)",
		)
		.bind(run.startedAt, run.startedAt)
		.run();
	await db
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('run','a','key','cancelled',?,?,?,?)",
		)
		.bind(encodeRun(run), run.startedAt, run.startedAt, run.startedAt)
		.run();
	const expansion = `UPDATE factory_runs SET payload=json_set(payload,'$.steps',json((
 SELECT json_group_array(json_set(value,
 '$.attempts',coalesce(json_extract(value,'$.attempts'),0),
 '$.startedAt',json_extract(value,'$.startedAt'),
 '$.finishedAt',json_extract(value,'$.finishedAt'),
 '$.durationMs',coalesce(json_extract(value,'$.durationMs'),0),
 '$.pages',coalesce(json_extract(value,'$.pages'),0),
 '$.error',json_extract(value,'$.error')))
 FROM json_each(factory_runs.payload,'$.steps'))))
 WHERE json_type(payload,'$.steps')='array'`;
	await db.prepare(expansion).run();
	await db.prepare(expansion).run();
	const restored = await db
		.prepare("SELECT payload FROM factory_runs WHERE id='run'")
		.first<{ payload: string }>();
	const legacy = JSON.parse(restored?.payload ?? "null") as typeof run;
	expect(legacy).toEqual(run);
	for (const step of legacy.steps) {
		step.attempts = Math.max(1, step.attempts);
		step.pages += 1;
		step.durationMs += 100;
		expect([step.attempts, step.pages, step.durationMs].every(Number.isFinite)).toBe(true);
	}
});
