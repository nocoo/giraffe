import { expect, it } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { createDb } from "./db/d1";
import { parseRefreshParams } from "./refresh-params";
import {
	activeRefreshRun,
	addRefreshRequests,
	createRefreshRun,
	getRefreshRun,
	listRefreshRuns,
	saveRefreshRun,
} from "./refresh-store";

const accountInsert =
	"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('account','owner','fake','fake','t','t')";
const runInsert =
	"INSERT INTO refresh_runs(id,account_id,status,trigger,schedule_day,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)";
const runSave =
	"UPDATE refresh_runs SET status=?,payload=?,updated_at=? WHERE account_id=? AND id=?";
const now = "2026-10-29T01:00:00.000Z";

const legacyPayload = (id: string, status: string) =>
	JSON.stringify({
		id,
		accountId: "account",
		status,
		phase: "repos",
		repos: ["owner/project"],
		completedRepos: 1,
		requests: 5,
		partial: false,
		errorCode: null,
		createdAt: "2026-10-28T19:00:00.000Z",
		updatedAt: "2026-10-28T20:00:00.000Z",
		finishedAt: null,
	});

async function fixture() {
	const raw = sqliteFixture();
	await raw.prepare(accountInsert).run();
	return { raw, db: createDb(raw) };
}

const fence = /refresh_(schema_cutover|terminal_run)/;
const blocked = (write: Promise<unknown>) => expect(write).rejects.toThrow(fence);
const oldSave = (raw: D1Database, id: string, status: string) =>
	raw.prepare(runSave).bind(status, legacyPayload(id, status), now, "account", id).run();

const cutoverRow = (raw: D1Database, id: string) =>
	raw
		.prepare(runInsert)
		.bind(
			id,
			"account",
			"failed",
			"manual",
			null,
			JSON.stringify({
				...JSON.parse(legacyPayload(id, "failed")),
				phase: "done",
				errorCode: "refresh_schema_cutover",
			}),
			"2026-10-28T19:00:00.000Z",
			"2026-10-28T20:00:00.000Z",
		)
		.run();

it("rejects legacy SQL even when its payload preserves modern fields", async () => {
	const { raw, db } = await fixture();
	const run = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date(now)),
		"manual",
		now,
	);
	for (const payload of [run, { ...run, requests: 1, partial: true }]) {
		await blocked(
			raw.prepare(runSave).bind("running", JSON.stringify(payload), now, "account", run.id).run(),
		);
		expect(await getRefreshRun(db, "account", run.id)).toEqual(run);
	}
	await saveRefreshRun(db, { ...run, status: "running" });
	await saveRefreshRun(db, { ...run, status: "completed", phase: "done", finishedAt: now });
	expect(
		await raw.prepare("SELECT writer_revision FROM refresh_runs WHERE id=?").bind(run.id).first(),
	).toEqual({ writer_revision: 2 });
});

it("keeps a cut over failed run terminal when the in-flight 0.27.0 runner writes running again", async () => {
	const { raw, db } = await fixture();
	await cutoverRow(raw, "legacy-running");
	const stored = async () =>
		raw
			.prepare("SELECT status,payload,updated_at FROM refresh_runs WHERE id=?")
			.bind("legacy-running")
			.first<{
				status: string;
				payload: string;
				updated_at: string;
			}>();
	const before = await stored();
	await blocked(oldSave(raw, "legacy-running", "running"));
	await blocked(oldSave(raw, "legacy-running", "queued"));
	expect(await stored()).toEqual(before);
	expect(await activeRefreshRun(db, "account")).toBeNull();
	expect(await getRefreshRun(db, "account", "legacy-running")).toMatchObject({
		status: "failed",
		errorCode: "refresh_schema_cutover",
	});
});

it("blocks legacy active inserts so they cannot occupy the active slot", async () => {
	const { raw, db } = await fixture();
	const legacyInsert = (
		id: string,
		status: string,
		trigger = "manual",
		day: string | null = null,
	) =>
		raw
			.prepare(runInsert)
			.bind(
				id,
				"account",
				status,
				trigger,
				day,
				legacyPayload(id, status),
				"2026-10-28T19:00:00.000Z",
				"2026-10-28T20:00:00.000Z",
			)
			.run();
	await blocked(legacyInsert("legacy-queued", "queued"));
	await blocked(legacyInsert("legacy-running", "running"));
	await blocked(legacyInsert("legacy-scheduled", "queued", "scheduled", "2026-10-29"));
	expect(await raw.prepare("SELECT COUNT(*) AS count FROM refresh_runs").first()).toEqual({
		count: 0,
	});
	expect(await activeRefreshRun(db, "account")).toBeNull();
	const modern = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date(now)),
		"manual",
		now,
	);
	expect(await activeRefreshRun(db, "account")).toEqual(modern);
	await blocked(legacyInsert("legacy-running-again", "running"));
	expect(await activeRefreshRun(db, "account")).toEqual(modern);
	expect(
		await createRefreshRun(
			db,
			"account",
			parseRefreshParams({}, new Date(now)),
			"scheduled",
			now,
			"2026-10-29",
		),
	).toMatchObject({ trigger: "scheduled", status: "queued" });
	expect(
		await raw.prepare("SELECT schedule_day FROM refresh_runs WHERE trigger='scheduled'").first(),
	).toEqual({ schedule_day: "2026-10-29" });
});

it("rejects terminal overwrite and legacy rewrites while accepting modern terminal writes", async () => {
	const { raw, db } = await fixture();
	const run = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date(now)),
		"manual",
		now,
	);
	await saveRefreshRun(db, { ...run, status: "running", updatedAt: now });
	await saveRefreshRun(db, {
		...run,
		status: "cancelled",
		phase: "done",
		cancelRequested: true,
		updatedAt: now,
		finishedAt: now,
	});
	await blocked(oldSave(raw, run.id, "running"));
	await blocked(
		raw.prepare(runSave).bind("running", JSON.stringify(run), now, "account", run.id).run(),
	);
	expect(await getRefreshRun(db, "account", run.id)).toMatchObject({
		id: run.id,
		status: "cancelled",
		cancelRequested: true,
		finishedAt: now,
		requestBreakdown: { total: 0 },
	});
	expect(await activeRefreshRun(db, "account")).toBeNull();
	const other = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date(now)),
		"manual",
		"2026-10-28T01:00:00.000Z",
	);
	await saveRefreshRun(db, { ...other, status: "running", updatedAt: now });
	const counted = addRefreshRequests(
		{ ...other, status: "partial", phase: "done", finishedAt: now },
		"b",
		{ graphql: 1, rest: 2 },
	);
	await saveRefreshRun(db, counted);
	expect(await getRefreshRun(db, "account", other.id)).toMatchObject({
		status: "partial",
		requests: 3,
		requestBreakdown: { total: 3, graphql: 1, rest: 2, b: { graphql: 1, rest: 2 } },
	});
	expect(await getRefreshRun(db, "account", run.id)).toMatchObject({ status: "cancelled" });
});

it("allows modern store progress past a legacy writer without losing observations", async () => {
	const { raw, db } = await fixture();
	await cutoverRow(raw, "legacy-running");
	await raw
		.prepare(
			"INSERT INTO refresh_day_observations(account_id,repo_id,timezone,day,dimension,status,payload,fetched_at) VALUES('account','R_APP','Asia/Shanghai','2026-10-28','commits','complete','{}','2026-10-28T20:00:00.000Z')",
		)
		.run();
	await blocked(oldSave(raw, "legacy-running", "running"));
	const created = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date(now)),
		"manual",
		now,
	);
	const active = await activeRefreshRun(db, "account");
	expect(active?.id).toBe(created.id);
	const running = { ...(active as typeof created), status: "running" as const, updatedAt: now };
	await saveRefreshRun(db, running);
	await blocked(oldSave(raw, "legacy-running", "completed"));
	const stepped = addRefreshRequests(running, "b", { graphql: 1, rest: 0 });
	await saveRefreshRun(db, {
		...stepped,
		phase: "done",
		status: "completed",
		finishedAt: now,
	});
	expect(await getRefreshRun(db, "account", created.id)).toMatchObject({
		status: "completed",
		requests: 1,
		requestBreakdown: { total: 1, graphql: 1, rest: 0, b: { graphql: 1, rest: 0 } },
	});
	expect(await getRefreshRun(db, "account", "legacy-running")).toMatchObject({
		status: "failed",
		errorCode: "refresh_schema_cutover",
	});
	expect((await listRefreshRuns(db, "account")).map((run) => run.status).sort()).toEqual([
		"completed",
		"failed",
	]);
	expect(
		await raw
			.prepare("SELECT repo_id,status FROM refresh_day_observations WHERE account_id='account'")
			.all(),
	).toMatchObject({ results: [{ repo_id: "R_APP", status: "complete" }] });
	const next = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date(now)),
		"manual",
		now,
	);
	expect(next.status).toBe("queued");
});
