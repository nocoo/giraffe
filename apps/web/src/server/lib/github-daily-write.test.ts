import { expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { dailyAt, dailyPayload } from "../../lib/__tests__/github-daily-fixture";
import {
	createResource,
	deleteResource,
	getResource,
	listResources,
	updateResource,
} from "./agent-resources";
import { createDb } from "./db/d1";

async function fixture() {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake',?,?),('b','other','fake','fake',?,?)",
		)
		.bind(dailyAt, dailyAt, dailyAt, dailyAt)
		.run();
	const write = (payload = dailyPayload(), account = "a", extra: Record<string, unknown> = {}) =>
		createResource(createDb(raw), account, "reports", {
			type: "github-daily",
			status: "completed",
			payload,
			...extra,
		});
	return { raw, write, db: () => createDb(raw) };
}

it("R8 concurrent same-date POSTs atomically replace one canonical row with distinct revisions", async () => {
	const state = await fixture();
	const results = await Promise.all(
		["first", "second", "third"].map((headline) => state.write({ ...dailyPayload(), headline })),
	);
	expect(results.map((row) => row.revision).sort()).toEqual([1, 2, 3]);
	expect(new Set(results.map((row) => row.id))).toEqual(new Set(["github-daily-2026-10-22"]));
	expect(new Set(results.map((row) => row.created_at)).size).toBe(1);
	const list = await listResources(state.db(), "a", "reports", {});
	expect(list.items).toHaveLength(1);
	expect(list.items[0]?.revision).toBe(3);
	expect((await state.write(dailyPayload(), "b")).revision).toBe(1);
	await expect(
		updateResource(state.db(), "a", "reports", results[0]?.id ?? "", {
			revision: 1,
			status: "completed",
		}),
	).rejects.toMatchObject({ status: 409 });
});

it.each([{ id: "noncanonical" }, { repository: "owner/app" }, { status: "pending" }])(
	"R8 rejects invalid daily creation envelopes %j before writes",
	async (extra) => {
		const state = await fixture();
		await expect(state.write(dailyPayload(), "a", extra)).rejects.toMatchObject({
			status: 400,
			code: "validation_failed",
		});
		expect((await listResources(state.db(), "a", "reports", {})).items).toEqual([]);
	},
);

it.each([
	{ type: "other", repository: null, payload: {} },
	{ type: "github-daily", repository: "owner/app", payload: dailyPayload() },
	{ type: "github-daily", repository: null, payload: dailyPayload("2026-10-21") },
	{ type: "github-daily", repository: null, payload: "{" },
	{ type: "github-daily", repository: null, payload: dailyPayload(), revision: 9007199254740991 },
	{ type: "github-daily", repository: null, payload: dailyPayload(), revision: 1.5 },
])("R8 canonical POST never overwrites a collision %j", async (row) => {
	const state = await fixture();
	await state.raw
		.prepare(
			"INSERT INTO agent_resources(account_id,collection,id,repository,type,status,payload,revision,created_at,updated_at) VALUES('a','reports','github-daily-2026-10-22',?,?,'completed',?,?,?,?)",
		)
		.bind(
			row.repository,
			row.type,
			typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload),
			"revision" in row ? row.revision : 1,
			dailyAt,
			dailyAt,
		)
		.run();
	const before = await state.raw.prepare("SELECT * FROM agent_resources").all();
	await expect(state.write()).rejects.toMatchObject({ status: 409, code: "resource_exists" });
	expect(await state.raw.prepare("SELECT * FROM agent_resources").all()).toEqual(before);
});

it("R8 canonical POST uses one SQL statement and deep invalid daily JSON never reaches D1", async () => {
	const state = await fixture();
	const db = state.db();
	await createResource(db, "a", "reports", {
		type: "github-daily",
		status: "completed",
		payload: dailyPayload(),
	});
	expect(db.statements).toBe(1);
	const untouched = state.db();
	const payload = JSON.parse(`{"headline":${"[".repeat(1001)}0${"]".repeat(1001)}}`);
	await expect(
		createResource(untouched, "a", "reports", {
			type: "github-daily",
			status: "completed",
			payload,
		}),
	).rejects.toMatchObject({ status: 400, code: "validation_failed" });
	expect(untouched.statements).toBe(0);
});

it("R8 daily PATCH validates full payload, type/date/global immutability and CAS without mutating rejected rows", async () => {
	const state = await fixture();
	const first = await state.write();
	for (const patch of [
		{ type: "other" },
		{ repository: "owner/app" },
		{ status: "failed" },
		{ payload: dailyPayload("2026-10-21") },
		{ payload: { headline: "partial" } },
	])
		await expect(
			updateResource(state.db(), "a", "reports", first.id, { revision: 1, ...patch }),
		).rejects.toMatchObject({ status: 400, code: "validation_failed" });
	expect((await getResource(state.db(), "a", "reports", first.id))?.revision).toBe(1);
	const results = await Promise.allSettled(
		["one", "two"].map((headline) =>
			updateResource(state.db(), "a", "reports", first.id, {
				revision: 1,
				payload: { ...dailyPayload(), headline },
			}),
		),
	);
	expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
	expect(results.find((row) => row.status === "rejected")).toMatchObject({
		reason: { status: 409 },
	});
	await createResource(state.db(), "a", "reports", {
		id: "ordinary",
		type: "ordinary",
		status: "pending",
		payload: {},
	});
	await expect(
		updateResource(state.db(), "a", "reports", "ordinary", {
			revision: 1,
			type: "github-daily",
			payload: dailyPayload(),
		}),
	).rejects.toMatchObject({ status: 400 });
});

it("R8 noncanonical legacy daily stays generically readable but PATCH rejects and explicit delete/canonical POST repairs", async () => {
	const state = await fixture();
	await state.raw
		.prepare(
			"INSERT INTO agent_resources(account_id,collection,id,type,status,payload,created_at,updated_at) VALUES('a','reports','legacy','github-daily','completed',?,?,?)",
		)
		.bind(JSON.stringify(dailyPayload()), dailyAt, dailyAt)
		.run();
	expect((await getResource(state.db(), "a", "reports", "legacy"))?.payload).toEqual(
		dailyPayload(),
	);
	await expect(
		updateResource(state.db(), "a", "reports", "legacy", { revision: 1 }),
	).rejects.toMatchObject({ status: 400, code: "validation_failed" });
	await deleteResource(state.db(), "a", "reports", "legacy", 1);
	expect((await state.write()).id).toBe("github-daily-2026-10-22");
});

it("R8 raw own special keys are rejected by POST and PATCH before generic Zod transformation", async () => {
	const state = await fixture();
	const first = await state.write();
	const payload = dailyPayload();
	Object.defineProperty(payload, "__proto__", {
		value: { hidden: "x".repeat(66000) },
		enumerable: true,
	});
	await expect(state.write(JSON.parse(JSON.stringify(payload)))).rejects.toMatchObject({
		status: 400,
	});
	await expect(
		updateResource(state.db(), "a", "reports", first.id, {
			revision: 1,
			payload: JSON.parse(JSON.stringify(payload)),
		}),
	).rejects.toMatchObject({ status: 400 });
	expect((await getResource(state.db(), "a", "reports", first.id))?.revision).toBe(1);
});

it("R8 supplied undefined daily PATCH fields reject before D1 mutation and exhausted revisions conflict safely", async () => {
	const state = await fixture();
	const first = await state.write();
	for (const patch of [
		{ payload: undefined },
		{ status: undefined },
		{ source_version: undefined },
	])
		await expect(
			updateResource(state.db(), "a", "reports", first.id, { revision: 1, ...patch }),
		).rejects.toMatchObject({ status: 400, code: "validation_failed" });
	await state.raw
		.prepare(
			"UPDATE agent_resources SET revision=9007199254740991 WHERE account_id='a' AND collection='reports'",
		)
		.run();
	await expect(
		updateResource(state.db(), "a", "reports", first.id, {
			revision: 9007199254740991,
			status: "completed",
		}),
	).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
	expect((await getResource(state.db(), "a", "reports", first.id))?.revision).toBe(
		9007199254740991,
	);
});

it("R8 a generic PATCH cannot overwrite a daily row recreated between its read and UPDATE", async () => {
	const state = await fixture();
	await createResource(state.db(), "a", "reports", {
		id: "github-daily-2026-10-22",
		type: "ordinary",
		status: "pending",
		payload: {},
	});
	const db = state.db();
	const prepare = db.prepare.bind(db);
	let replaced = false;
	vi.spyOn(db, "prepare").mockImplementation((sql) => {
		if (sql.startsWith("UPDATE agent_resources") && !replaced) {
			replaced = true;
			const statement = prepare(sql);
			const bind = statement.bind.bind(statement);
			statement.bind = (...values: unknown[]) => {
				const bound = bind(...values);
				const run = bound.run.bind(bound);
				bound.run = async <Result>() => {
					await state.raw
						.prepare("DELETE FROM agent_resources WHERE account_id='a' AND collection='reports'")
						.run();
					await state.write();
					return run<Result>();
				};
				return bound;
			};
			return statement;
		}
		return prepare(sql);
	});
	await expect(
		updateResource(db, "a", "reports", "github-daily-2026-10-22", {
			revision: 1,
			status: "failed",
		}),
	).rejects.toMatchObject({ status: 409 });
	expect((await getResource(state.db(), "a", "reports", "github-daily-2026-10-22"))?.type).toBe(
		"github-daily",
	);
});
