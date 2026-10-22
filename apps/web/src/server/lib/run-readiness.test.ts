import { beforeEach, expect, it } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { type FactoryRun, makeRun } from "../../lib/factory-run";
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
	const run = await seed("sample", { status: "partial" }, "2026-10-20T00:00:00.000Z");
	await seed("active", {
		status: "running",
		finishedAt: null,
		error: "run_timed_out",
		steps: run.steps.map((step) => ({ ...step, status: "failed", error: "snapshot_incomplete" })),
	});
	expect(await read("daily")).toMatchObject({
		expectedFinishAt: finished,
		expectedFinishAtReason: null,
		lastError: "run_timed_out",
	});
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
