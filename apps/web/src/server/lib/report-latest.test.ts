import { expect, it, vi } from "vitest";
import { analysisTimeCases } from "../../../../../tests/fixtures/analysis-times";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { dailyAt, dailyResource } from "../../lib/__tests__/github-daily-fixture";
import { createResource } from "./agent-resources";
import { createDb } from "./db/d1";
import { readGithubDailyHistory, readLatestReport } from "./report-latest";

async function fixture() {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake',?,?),('b','other','fake','fake',?,?)",
		)
		.bind(dailyAt, dailyAt, dailyAt, dailyAt)
		.run();
	const seed = (row: Record<string, unknown>) =>
		raw
			.prepare(
				"INSERT INTO agent_resources(account_id,collection,id,repository,type,status,source_version,payload,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
			)
			.bind(
				row.account_id ?? "a",
				row.collection ?? "reports",
				row.id,
				row.repository ?? null,
				row.type,
				row.status,
				row.source_version ?? null,
				typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload),
				row.revision ?? 1,
				row.created_at ?? dailyAt,
				row.updated_at ?? dailyAt,
			)
			.run();
	return { raw, seed, db: () => createDb(raw) };
}

it.each(analysisTimeCases)(
	"R8 generic latest orders $name and ignores edit times",
	async ({ entries, expected }) => {
		const state = await fixture();
		for (const [id, generatedAt] of entries)
			await state.seed({
				id,
				type: "custom",
				status: "pending",
				payload: { generatedAt },
				updated_at: id === "z" ? "2099-01-01T00:00:00Z" : dailyAt,
			});
		const result = await readLatestReport(state.db(), "a", { type: ["custom"] });
		expect(result.item?.id).toBe(expected[0]);
		expect(result).not.toHaveProperty("invalidCount");
	},
);

it.each(analysisTimeCases)(
	"R8 daily latest/history use the same exact $name",
	async ({ entries, expected }) => {
		const state = await fixture();
		const dates = new Map(
			[...entries]
				.sort(([left], [right]) => (left < right ? -1 : 1))
				.map(([id], index) => [id, `2026-10-${String(index + 1).padStart(2, "0")}`]),
		);
		for (const [id, generatedAt] of entries)
			await state.seed(dailyResource(dates.get(id), generatedAt));
		const history = await readGithubDailyHistory(state.db(), "a");
		expect(history.items.slice(0, 3).map((row) => row.payload.date)).toEqual(
			expected.map((id) => dates.get(id)),
		);
		expect((await readLatestReport(state.db(), "a", { type: ["github-daily"] })).item).toEqual(
			history.items[0],
		);
	},
);

it("R8 generic latest retains fractional precision beyond the daily 128-character cap", async () => {
	const state = await fixture();
	for (const [id, tail] of [
		["z-older", "1"],
		["a-newer", "2"],
	])
		await state.seed({
			id,
			type: "custom",
			status: "completed",
			payload: { generatedAt: `2026-10-22T00:00:00.${"0".repeat(300)}${tail}Z` },
		});
	expect((await readLatestReport(state.db(), "a", { type: ["custom"] })).item?.id).toBe("a-newer");
});

it("R8 all-invalid reports return empty selections without throwing, and regenerated reporting dates order by generation", async () => {
	const state = await fixture();
	for (const [index, payload] of ["{", null, [], {}, 1, { generatedAt: 1 }].entries())
		await state.seed({ id: `invalid-${index}`, type: "custom", status: "pending", payload });
	expect(await readLatestReport(state.db(), "a", { type: ["custom"] })).toEqual({
		account_id: "a",
		item: null,
	});
	await state.seed({ ...dailyResource(), id: "legacy" });
	expect(await readGithubDailyHistory(state.db(), "a")).toEqual({
		account_id: "a",
		items: [],
		invalidCount: 1,
	});
	await state.seed(dailyResource("2020-01-01", "2026-10-23T00:00:00Z"));
	await state.seed(dailyResource("2026-10-22", "2026-10-22T00:00:00Z"));
	expect((await readGithubDailyHistory(state.db(), "a")).items[0]?.payload.date).toBe("2020-01-01");
});

it("R8 generic latest searches all retained rows, skips invalid generation times and supports JSON deeper than JSON1", async () => {
	const state = await fixture();
	for (let index = 0; index < 105; index++)
		await createResource(state.db(), "a", "reports", {
			id: `a-${index}`,
			type: "custom",
			status: "completed",
			payload: { generatedAt: "2020-01-01T00:00:00Z" },
		});
	for (const [id, generatedAt] of [
		["invalid", "now"],
		["invalid-date", "2026-02-30T00:00:00Z"],
		["relative", "subsec"],
	])
		await state.seed({ id, type: "custom", status: "completed", payload: { generatedAt } });
	const payload = JSON.parse(
		`{"generatedAt":"2026-10-22T00:00:00.0000000001Z","opaque":${"[".repeat(1001)}0${"]".repeat(1001)}}`,
	);
	await state.seed({ id: "z-winner", type: "custom", status: "pending", payload });
	await state.seed({
		id: "other-account",
		account_id: "b",
		type: "custom",
		status: "completed",
		payload: { generatedAt: "2099-01-01T00:00:00Z" },
	});
	await state.seed({
		id: "other-collection",
		collection: "jobs",
		type: "custom",
		status: "completed",
		payload: { generatedAt: "2099-01-01T00:00:00Z" },
	});
	expect((await readLatestReport(state.db(), "a", { type: ["custom"] })).item).toMatchObject({
		id: "z-winner",
		payload,
	});
	expect(await readLatestReport(state.db(), "a", { type: ["missing"] })).toEqual({
		account_id: "a",
		item: null,
	});
});

it("R8 canonical daily history/latest share seven valid winners and count every invalid retained row without writes", async () => {
	const state = await fixture();
	for (let index = 1; index <= 10; index++)
		await state.seed(
			dailyResource(
				`2026-10-${String(index).padStart(2, "0")}`,
				`2026-10-${String(index).padStart(2, "0")}T00:00:00Z`,
			),
		);
	for (let index = 0; index < 105; index++)
		await state.seed({
			...dailyResource(),
			id: `legacy-${index}`,
			payload: { ...dailyResource().payload, generatedAt: "2099-01-01T00:00:00Z" },
		});
	await state.seed({ ...dailyResource(), id: "bad-json", payload: "{" });
	await state.seed({ ...dailyResource("2026-10-20"), repository: "owner/app" });
	await state.seed({ ...dailyResource("2026-10-21"), status: "pending" });
	await state.seed({ ...dailyResource("2026-10-23"), payload: {} });
	await state.seed({ ...dailyResource("2026-10-24"), account_id: "b" });
	const before = await state.raw
		.prepare("SELECT * FROM agent_resources ORDER BY account_id,id")
		.all();
	const network = vi.spyOn(globalThis, "fetch");
	try {
		const history = await readGithubDailyHistory(state.db(), "a");
		expect(history.items.map((row) => row.payload.date)).toEqual([
			"2026-10-10",
			"2026-10-09",
			"2026-10-08",
			"2026-10-07",
			"2026-10-06",
			"2026-10-05",
			"2026-10-04",
		]);
		expect(history.invalidCount).toBe(109);
		expect(await readLatestReport(state.db(), "a", { type: ["github-daily"] })).toEqual({
			account_id: "a",
			item: history.items[0],
			invalidCount: history.invalidCount,
		});
		expect(await readGithubDailyHistory(state.db(), "empty")).toEqual({
			account_id: "empty",
			items: [],
			invalidCount: 0,
		});
		expect(network).not.toHaveBeenCalled();
		expect(
			await state.raw.prepare("SELECT * FROM agent_resources ORDER BY account_id,id").all(),
		).toEqual(before);
	} finally {
		network.mockRestore();
	}
});

const invalidQueries: Record<string, string[]>[] = [
	{},
	{ type: [] },
	{ type: ["custom", "other"] },
	{ type: ["custom"], limit: ["1"] },
	{ type: [""] },
];
it.each(invalidQueries)("R8 latest validates strict one-type queries %j", async (query) => {
	const state = await fixture();
	await expect(readLatestReport(state.db(), "a", query)).rejects.toMatchObject({
		status: 400,
		code: "validation_failed",
	});
});
