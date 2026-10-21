import { expect, it, vi } from "vitest";
import { createDb } from "./db/d1";
import { SourceTiming } from "./source-timing";

it("accumulates fixed phases and records failed operations without diagnostic text", async () => {
	let now = 0;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => now++);
	try {
		const timing = new SourceTiming();
		expect(timing.measure("decode", () => 42)).toBe(42);
		expect(() =>
			timing.measure("decode", () => {
				throw new Error("private diagnostic");
			}),
		).toThrow();
		await expect(
			timing.measureAsync("hash", async () => {
				throw new Error("private hash");
			}),
		).rejects.toThrow();
		expect(await timing.measureAsync("hash", async () => "value")).toBe("value");
		timing.recordD1(12, [0.5, null, NaN, -1, Infinity]);
		timing.recordD1(NaN, []);
		expect(timing.header()).toContain("decode;dur=2.00");
		expect(timing.header()).toContain("hash;dur=2.00");
		expect(timing.header()).toContain("d1_1;dur=12.00, sql_1;dur=0.50");
		expect(timing.header()).not.toMatch(/private|NaN|Infinity|sql_[2345]|d1_2/);
	} finally {
		clock.mockRestore();
	}
});

it("times one batch round trip and reports only valid D1 query execution durations", async () => {
	const result = { results: [], success: true, meta: { duration: 1.25 } };
	const statement = {
		all: async () => result,
		first: async () => null,
		run: async () => ({ ...result, meta: { duration: -1 } }),
	} as unknown as D1PreparedStatement;
	const raw = {
		prepare: () => statement,
		batch: async () => [result, { ...result, meta: { duration: "private" } }],
	} as unknown as D1Database;
	const observer = vi.fn();
	const db = createDb(raw, observer);
	await db.prepare("SELECT private_column").first();
	await db.prepare("SELECT private_column").all();
	await db.prepare("SELECT private_column").run();
	await db.batch([db.prepare("SELECT secret_one"), db.prepare("SELECT secret_two")]);
	expect(observer.mock.calls.map((call) => call[1])).toEqual([
		[null],
		[1.25],
		[null],
		[1.25, null],
	]);
	expect(db.statements).toBe(5);
	for (const call of observer.mock.calls) expect(call[0]).toBeGreaterThanOrEqual(0);
	const failing = createDb(
		{
			prepare: () => ({
				all: async () => {
					throw new Error("private");
				},
			}),
		} as unknown as D1Database,
		observer,
	);
	await expect(failing.prepare("SELECT private").all()).rejects.toMatchObject({ code: "db_error" });
	expect(observer).toHaveBeenLastCalledWith(expect.any(Number), [null]);
	expect(JSON.stringify(observer.mock.calls)).not.toContain("private");
});
