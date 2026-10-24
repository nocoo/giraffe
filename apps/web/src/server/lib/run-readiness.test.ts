import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { type FactoryRun, type FactoryRunStep, makeRun } from "../../lib/factory-run";
import { createDb } from "./db/d1";
import { readLatestRun } from "./run-readiness";

const started = "2026-10-21T21:00:00.000Z";
const finished = "2026-10-21T21:30:00.000Z";
type StoredRun = Omit<Partial<FactoryRun>, "depth" | "trigger"> & {
	depth?: FactoryRun["depth"];
	trigger?: FactoryRun["trigger"];
};
let raw: D1Database;
beforeEach(async () => {
	raw = sqliteFixture();
	for (const id of ["a", "b"])
		await raw
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?,'encrypted','fake',?,?)",
			)
			.bind(id, id, started, started)
			.run();
});

async function seed(id: string, input: StoredRun = {}, createdAt = started) {
	const run = {
		...makeRun(id, "a", "owner", id, "refresh", [], started),
		depth: "quick" as const,
		trigger: "daily" as const,
		status: "completed" as const,
		finishedAt: finished,
		...input,
	};
	await raw
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
		)
		.bind(id, run.account_id, id, run.status, JSON.stringify(run), started, createdAt, started)
		.run();
	return run;
}
const read = (kind: string) => readLatestRun(createDb(raw), "a", { kind: [kind] });

it.each([
	["daily", { trigger: "daily" }, "daily"],
	["weekly", { trigger: "weekly", depth: "deep" }, "weekly"],
	["catalog", { mode: "catalog", trigger: "manual" }, "catalog"],
	["manual", { trigger: undefined }, "manual"],
	["quick", { trigger: "weekly", depth: "quick" }, "weekly"],
	["deep", { trigger: "daily", depth: undefined }, "daily"],
] as const)(
	"R9 latest selects %s beyond the history cap and returns canonical kind and saved window",
	async (kind, input, canonicalKind) => {
		const run = await seed("retained-target", input);
		for (let i = 0; i < 25; i++)
			await seed(
				`newer-other-kind-${i}`,
				{ mode: kind === "catalog" ? "refresh" : "catalog" },
				"2026-10-22T00:00:00.000Z",
			);
		await seed("other-account", { ...input, account_id: "b" }, "2026-10-23T00:00:00.000Z");
		expect(await read(kind)).toMatchObject({
			account_id: "a",
			id: "retained-target",
			kind: canonicalKind,
			window: run.window,
		});
	},
);

it("R9 latest breaks creation-time ties by descending ID and ignores update/start/finish ordering", async () => {
	await seed("a", {
		startedAt: "2026-10-22T00:00:00.000Z",
		finishedAt: "2026-10-23T00:00:00.000Z",
	});
	await seed("z");
	await seed("old", { updatedAt: "2026-10-24T00:00:00.000Z" }, "2026-10-20T00:00:00.000Z");
	expect((await read("daily")).id).toBe("z");
});

it.each(["completed", "partial", "running", "paused", "failed", "cancelled"] as const)(
	"R9 latest only exposes a stored publication for finished publishable status %s",
	async (status) => {
		await seed("publication", { status, publishedAt: finished });
		expect((await read("daily")).publishedAt).toBe(
			status === "completed" || status === "partial" ? finished : null,
		);
	},
);

it("R9 latest normalizes missing historical markers to null but retains the catalog collection window", async () => {
	const run = await seed("legacy", { mode: "catalog" });
	delete run.publishedAt;
	await raw
		.prepare("UPDATE factory_runs SET payload=? WHERE id=?")
		.bind(JSON.stringify(run), run.id)
		.run();
	expect(await read("catalog")).toMatchObject({ window: run.window, publishedAt: null });
});

it("R9 latest reuses partial-aware estimates and prioritizes the run error over failed-step errors", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-23T00:00:00.000Z"));
	try {
		const run = await seed("sample", { status: "partial" }, "2026-10-20T00:00:00.000Z");
		await seed("active", {
			status: "running",
			finishedAt: null,
			error: "run_timed_out",
			steps: run.steps.map((step) => ({ ...step, status: "failed", error: "snapshot_incomplete" })),
		});
		expect(await read("daily")).toMatchObject({
			expectedFinishAt: "2026-10-23T00:00:00.000Z",
			expectedFinishAtReason: null,
			lastError: "run_timed_out",
		});
	} finally {
		vi.useRealTimers();
	}
});

it.each([
	{},
	{ kind: [] },
	{ kind: [""] },
	{ kind: ["Daily"] },
	{ kind: ["daily", "daily"] },
	{ kind: ["daily"], unknown: ["value"] },
])("R9 latest strictly rejects invalid queries %j", async (query) => {
	await expect(readLatestRun(createDb(raw), "a", query)).rejects.toMatchObject({
		status: 400,
		code: "validation_failed",
	});
});

it("R9 latest returns not_found when the account has no retained matching run", async () => {
	await expect(read("daily")).rejects.toMatchObject({ status: 404, code: "not_found" });
});

it.each([
	{
		kind: "catalog",
		input: { mode: "catalog", trigger: "manual", depth: "quick" },
		canonicalKind: "catalog",
		depth: null,
	},
	{
		kind: "daily",
		input: { trigger: "daily", depth: "quick" },
		canonicalKind: "daily",
		depth: "quick",
	},
	{
		kind: "weekly",
		input: { trigger: "weekly", depth: "deep" },
		canonicalKind: "weekly",
		depth: "deep",
	},
	{
		kind: "daily",
		input: { trigger: "daily", depth: undefined },
		canonicalKind: "daily",
		depth: "deep",
	},
	{
		kind: "deep",
		input: { trigger: "daily", depth: undefined },
		canonicalKind: "daily",
		depth: "deep",
	},
	{
		kind: "quick",
		input: { trigger: "manual", depth: "quick" },
		canonicalKind: "manual",
		depth: "quick",
	},
] as const)(
	"R9 latest filter $kind returns kind $canonicalKind depth $depth",
	async ({ kind, input, canonicalKind, depth }) => {
		await seed("depth-target", input);
		expect(await read(kind)).toMatchObject({ kind: canonicalKind, depth });
	},
);

it.each([
	{ status: "completed", input: { publishedAt: finished }, publishedAt: finished, reason: null },
	{ status: "partial", input: { publishedAt: finished }, publishedAt: finished, reason: null },
	{ status: "completed", input: { publishedAt: null }, publishedAt: null, reason: "not_published" },
	{ status: "partial", input: { publishedAt: null }, publishedAt: null, reason: "not_published" },
	{
		status: "running",
		input: { publishedAt: finished, finishedAt: null },
		publishedAt: null,
		reason: "in_progress",
	},
	{
		status: "paused",
		input: { publishedAt: finished, finishedAt: null },
		publishedAt: null,
		reason: "in_progress",
	},
	{ status: "failed", input: { publishedAt: finished }, publishedAt: null, reason: "failed" },
	{ status: "cancelled", input: { publishedAt: finished }, publishedAt: null, reason: "cancelled" },
] as const)(
	"R9 latest $status publishedAtReason is $reason",
	async ({ status, input, publishedAt, reason }) => {
		await seed("publication-reason", { status, ...input });
		expect(await read("daily")).toMatchObject({ publishedAt, publishedAtReason: reason });
	},
);

it("R9 latest treats a missing publishedAt property as legacy_unprovable", async () => {
	const run = await seed("legacy-absent", { status: "completed", publishedAt: null });
	delete run.publishedAt;
	await raw
		.prepare("UPDATE factory_runs SET payload=? WHERE id=?")
		.bind(JSON.stringify(run), run.id)
		.run();
	expect("publishedAt" in JSON.parse(JSON.stringify(run))).toBe(false);
	expect(await read("daily")).toMatchObject({
		publishedAt: null,
		publishedAtReason: "legacy_unprovable",
	});
});

it("R9 latest treats explicit null publishedAt without atomicPublication as legacy_unprovable", async () => {
	const run = await seed("legacy-capability", { status: "completed", publishedAt: null });
	delete run.atomicPublication;
	await raw
		.prepare("UPDATE factory_runs SET payload=? WHERE id=?")
		.bind(JSON.stringify(run), run.id)
		.run();
	expect(await read("daily")).toMatchObject({
		publishedAt: null,
		publishedAtReason: "legacy_unprovable",
	});
});

it("R9 latest applies 0022 null timestamps without inventing atomic publication readiness", async () => {
	const run = await seed("migrated-0022", { status: "completed" });
	delete run.publishedAt;
	delete run.atomicPublication;
	await raw
		.prepare("UPDATE factory_runs SET payload=? WHERE id=?")
		.bind(JSON.stringify(run), run.id)
		.run();
	const types = (id: string) =>
		raw
			.prepare(
				"SELECT json_type(payload,'$.publishedAt') AS publishedAtType, json_type(payload,'$.atomicPublication') AS atomicPublicationType FROM factory_runs WHERE id=?",
			)
			.bind(id)
			.first<{ publishedAtType: string | null; atomicPublicationType: string | null }>();
	expect(await types(run.id)).toMatchObject({ publishedAtType: null, atomicPublicationType: null });
	await raw.prepare(readFileSync("migrations/0022_run_readiness.sql", "utf8")).run();
	expect(await types(run.id)).toMatchObject({
		publishedAtType: "null",
		atomicPublicationType: null,
	});
	expect(await read("daily")).toMatchObject({
		publishedAt: null,
		publishedAtReason: "legacy_unprovable",
	});
});

it("R9 latest projects metadata and failed steps without transferring unused payload", async () => {
	const base = makeRun("base", "a", "owner", "base", "catalog", [], started)
		.steps[0] as FactoryRunStep;
	const run = await seed("huge", {
		status: "partial",
		publishedAt: finished,
		activityWindow: {
			since: "2026-10-20T21:00:00.000Z",
			until: started,
			first: false,
			gap: false,
		},
		steps: (["success", "failed", "unavailable", "limited", "skipped"] as const).map(
			(status): FactoryRunStep => ({
				...base,
				kind: "snapshot",
				repo: "owner/repo",
				status,
				error: status === "failed" ? "snapshot_incomplete" : null,
				...(status === "failed" ? { resource: "repo:owner/repo:security" } : {}),
			}),
		),
	});
	const unused = "x".repeat(250_000);
	const bloated = JSON.parse(JSON.stringify(run)) as Record<string, unknown>;
	bloated.unused = unused;
	bloated.checkpoint = { blob: unused };
	const steps = bloated.steps as Record<string, unknown>[];
	if (steps[0]) steps[0].unused = unused;
	if (steps[1]) steps[1].sourceHead = unused;
	await raw
		.prepare("UPDATE factory_runs SET payload=? WHERE id=?")
		.bind(JSON.stringify(bloated), run.id)
		.run();
	const queries: string[] = [];
	const originalPrepare = raw.prepare.bind(raw);
	raw.prepare = ((query: string) => {
		queries.push(query);
		return originalPrepare(query);
	}) as D1Database["prepare"];
	const parsed: string[] = [];
	const originalParse = JSON.parse;
	const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
		if (typeof text === "string") parsed.push(text);
		return originalParse(text, reviver);
	});
	try {
		expect(await read("daily")).toEqual({
			account_id: "a",
			id: "huge",
			kind: "daily",
			depth: "quick",
			status: "partial",
			window: {
				since: "2026-10-20T21:00:00.000Z",
				until: started,
				first: false,
				gap: false,
			},
			startedAt: started,
			expectedFinishAt: null,
			expectedFinishAtReason: "terminal",
			finishedAt: finished,
			counts: { total: 5, success: 1, failed: 1, unavailable: 1, limited: 1, skipped: 1 },
			failedSteps: [
				{
					kind: "snapshot",
					repo: "owner/repo",
					resource: "repo:owner/repo:security",
					error: "snapshot_incomplete",
				},
			],
			lastError: "snapshot_incomplete",
			publishedAt: finished,
			publishedAtReason: null,
		});
		const latestSql = queries.find(
			(query) => query.includes("factory_runs") && query.includes("LIMIT 1"),
		);
		expect(latestSql).toMatch(/json_extract\(payload,'\$\.id'\)/);
		expect(latestSql).toMatch(/json_type\(payload,'\$\.publishedAt'\)/);
		expect(latestSql).toMatch(/json_type\(payload,'\$\.atomicPublication'\)/);
		expect(latestSql).toMatch(/json_each\(payload,'\$\.steps'\)/);
		expect(latestSql).toMatch(/json_group_array/);
		expect(latestSql).not.toMatch(/json_remove/);
		expect(latestSql).not.toMatch(/AS payload/);
		expect(latestSql).not.toMatch(/\$\.checkpoint/);
		expect(latestSql).not.toMatch(/json_extract\(payload,'\$\.steps'\)/);
		expect(parsed.some((text) => text.includes(unused))).toBe(false);
		expect(Math.max(0, ...parsed.map((text) => text.length))).toBeLessThan(unused.length);
	} finally {
		parseSpy.mockRestore();
		raw.prepare = originalPrepare;
	}
});
