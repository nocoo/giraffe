import { expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../../tests/fixtures/sqlite";
import { createDb } from "../db/d1";
import type { CollectionContext } from "../refresh-collection-contract";
import { refreshDays } from "../refresh-params";
import type { DayObservation } from "./model";
import { dayStatements } from "./store";

const now = "2026-10-29T06:00:00.000Z";
const context = {
	account: { id: "a" },
	run: { params: { since: "2026-07-31", until: "2026-10-28", timezone: "Asia/Shanghai" } },
} as CollectionContext;
const byteLength = (text: string) => new TextEncoder().encode(text).length;

async function fixture() {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','encrypted','test',?,?)",
		)
		.bind(now, now)
		.run();
	const binds: string[] = [];
	const prepare = raw.prepare.bind(raw);
	vi.spyOn(raw, "prepare").mockImplementation((sql) => {
		const statement = prepare(sql);
		const bind = statement.bind.bind(statement);
		vi.spyOn(statement, "bind").mockImplementation((...values: unknown[]) => {
			for (const value of values) {
				if (typeof value !== "string") continue;
				if (byteLength(value) > 2_000_000) throw new Error("D1 string capacity exceeded");
			}
			if (sql.startsWith("INSERT INTO refresh_day_observations")) binds.push(String(values[3]));
			return bind(...values);
		});
		return statement;
	});
	return { raw, db: createDb(raw), binds };
}

function observations(): DayObservation[] {
	const items = Array.from({ length: 100 }, (_, index) => ({
		id: `alert-${index}`,
		title: "安全更新 🚨 ".repeat(35),
		url: `https://github.com/owner/project/security/alerts/${index}`,
		state: "open",
	}));
	return refreshDays(context.run.params).map((day) => ({
		day: day.date,
		dimension: "alerts",
		status: "complete",
		payload: JSON.stringify({ items, count: items.length, since: day.since, until: day.until }),
		fetched_at: now,
	}));
}

it("writes all 90 nonempty alert days through byte-bounded JSON bindings", async () => {
	const { raw, db, binds } = await fixture();
	const rows = observations();
	expect(byteLength(JSON.stringify(rows))).toBeGreaterThan(2_000_000);
	const statements = dayStatements(db, context, "R_1", rows);
	await db.batch(statements);
	expect(binds.length).toBeGreaterThan(1);
	expect(binds.every((value) => byteLength(value) <= 1_500_000)).toBe(true);
	expect(binds.flatMap((value) => JSON.parse(value))).toEqual(rows);
	expect(
		(
			await raw
				.prepare(
					"SELECT day,dimension,status,payload,fetched_at FROM refresh_day_observations ORDER BY day",
				)
				.all()
		).results,
	).toEqual(rows);
});

it("rolls back earlier chunks if a later observation violates the schema", async () => {
	const { raw, db } = await fixture();
	const rows = observations();
	rows.push({ ...rows[0], day: "2026-10-29", dimension: "invalid" } as DayObservation);
	await expect(db.batch(dayStatements(db, context, "R_1", rows))).rejects.toMatchObject({
		code: "db_error",
	});
	expect(
		await raw.prepare("SELECT COUNT(*) AS count FROM refresh_day_observations").first(),
	).toEqual({ count: 0 });
});

it("keeps an exactly fitting UTF-8 batch and starts the next row in another batch", async () => {
	const { db, binds } = await fixture();
	const row: DayObservation = {
		day: "2026-07-31",
		dimension: "alerts",
		status: "complete",
		payload: JSON.stringify({ title: "" }),
		fetched_at: now,
	};
	row.payload = JSON.stringify({
		title: "a".repeat(1_500_000 - byteLength(JSON.stringify([row]))),
	});
	const next = { ...row, day: "2026-08-01", payload: "{}" };
	await db.batch(dayStatements(db, context, "R_1", [row, next]));
	expect(binds.map(byteLength)).toEqual([1_500_000, byteLength(JSON.stringify([next]))]);
});

it("does not prepare empty writes or silently drop a single oversized observation", async () => {
	const { db, binds } = await fixture();
	expect(dayStatements(db, context, "R_1", [])).toEqual([]);
	const [row] = observations();
	expect(() =>
		dayStatements(db, context, "R_1", [
			{ ...row, payload: JSON.stringify({ title: "大".repeat(500_000) }) } as DayObservation,
		]),
	).toThrow();
	expect(binds).toEqual([]);
});
