import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { type FactoryRun, type FactoryRunStep, makeRun } from "../../lib/factory-run";
import type { Env } from "../env";
import { createApp } from "../index";
import { createApiToken } from "../lib/api-tokens";
import { createDb } from "../lib/db/d1";

const account = "a".repeat(21);
const other = "b".repeat(21);
const now = "2026-10-22T00:00:00.000Z";
type RunJson = {
	id: string;
	steps: unknown[];
	expectedFinishAt: string | null;
	expectedFinishAtReason: string | null;
	counts?: { total: number };
	progress?: { total: number };
};

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(now));
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function setup() {
	const raw = sqliteFixture();
	for (const id of [account, other])
		await raw
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?,?,'encrypted','fake',?,?,?)",
			)
			.bind(id, id, Number(id === account), now, now)
			.run();
	const token = await createApiToken(createDb(raw), {
		accountId: account,
		label: "eta-test",
		scopes: ["app:read"],
		expiresInDays: 1,
		creator: "test@local",
	});
	async function seed(id: string, input: Partial<FactoryRun>, createdAt?: string) {
		const run = { ...makeRun(id, account, "owner", id, "refresh", [], now), ...input };
		await raw
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
			)
			.bind(
				id,
				run.account_id,
				id,
				run.status,
				JSON.stringify(run),
				run.startedAt,
				createdAt ?? run.startedAt,
				run.startedAt,
			)
			.run();
	}
	const app = createApp();
	const env = {
		DB: raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
	} as unknown as Env;
	const call = (machine: boolean, history = "") =>
		app.request(
			`http://localhost${machine ? `/api/v1/accounts/${account}/refresh-runs` : `/api/factory/runs${history ? `?history=${history}` : ""}`}`,
			{ headers: machine ? { authorization: `Bearer ${token.token}` } : {} },
			env,
		);
	async function savedRows() {
		const tables = await raw
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all<{ name: string }>();
		return Promise.all(
			tables.results.map(async ({ name }) => ({
				name,
				rows: (await raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results,
			})),
		);
	}
	const latest = (machine: boolean, kind: string) =>
		app.request(
			`http://localhost${machine ? `/api/v1/accounts/${account}/refresh-runs/latest` : "/api/factory/runs/latest"}?kind=${kind}`,
			{ headers: machine ? { authorization: `Bearer ${token.token}` } : {} },
			env,
		);
	return { raw, seed, call, latest, savedRows };
}

it("projects matching browser/detail/machine ETA from retained history in one read per GET", async () => {
	const s = await setup();
	for (const [index, duration] of [900000, 10000, 20000, 30000, 40000, 50000].entries()) {
		const start = `2026-09-0${index + 1}T00:00:00.000Z`;
		await s.seed(`sample-${index}`, {
			status: "completed",
			startedAt: start,
			finishedAt: new Date(Date.parse(start) + duration).toISOString(),
		});
	}
	for (let index = 1; index <= 22; index++)
		await s.seed(`failed-${index}`, {
			status: "failed",
			startedAt: `2026-10-${String(index).padStart(2, "0")}T00:00:00.000Z`,
			finishedAt: now,
		});
	await s.seed("foreign", {
		account_id: other,
		status: "completed",
		finishedAt: "2026-10-22T01:00:00.000Z",
	});
	await s.seed("current", {
		status: "running",
		startedAt: "2026-10-21T00:00:00.000Z",
		deadlineAt: "2026-10-21T12:00:00.000Z",
	});
	const before = await s.savedRows();
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	const prepare = vi.spyOn(s.raw, "prepare");
	async function read(machine: boolean, history = "") {
		prepare.mockClear();
		const response = await s.call(machine, history);
		expect(response.status).toBe(200);
		expect(prepare.mock.calls.filter(([sql]) => sql.includes("PARTITION BY kind"))).toHaveLength(1);
		const body = (await response.json()) as {
			current?: RunJson;
			history?: RunJson[];
			items?: RunJson[];
		};
		return body.items ?? [...(body.current ? [body.current] : []), ...(body.history ?? [])];
	}
	const browser = await read(false);
	const machine = await read(true);
	for (const list of [browser, machine]) {
		expect(list).toHaveLength(21);
		for (const run of list) {
			expect(run).toHaveProperty("expectedFinishAt");
			expect(run).toHaveProperty(
				"expectedFinishAtReason",
				run.id === "current" ? null : "terminal",
			);
			expect(run).not.toHaveProperty("checkpoint");
		}
		expect(list.find((run) => run.id === "current")).toMatchObject({
			expectedFinishAt: "2026-10-22T00:00:30.000Z",
		});
		expect(list.find((run) => run.id === "failed-21")).toMatchObject({
			steps: [],
			expectedFinishAt: null,
			expectedFinishAtReason: "terminal",
		});
	}
	const detail = await read(false, "failed-21");
	const detailed = detail.find((run) => run.id === "failed-21");
	const compact = browser.find((run) => run.id === "failed-21");
	if (!detailed || !compact) throw new Error("missing fixture run");
	expect(detailed.steps.length).toBeGreaterThan(0);
	expect(detailed.expectedFinishAt).toBe(compact.expectedFinishAt);
	expect(detailed.progress?.total).toBe(detailed.steps.length);
	expect(await s.savedRows()).toEqual(before);
	expect(fetch).not.toHaveBeenCalled();
});

it("prioritizes terminal reasons on compact browser and machine entries without historical samples", async () => {
	const s = await setup();
	await s.seed("no-history", { status: "failed" });
	await s.seed("invalid-start", { status: "failed", startedAt: "invalid" }, now);
	await s.seed("no-work", { status: "failed", steps: [], error: "scheduled_slot_missed" });
	for (const machine of [false, true]) {
		const response = await s.call(machine);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { items?: RunJson[]; history?: RunJson[] };
		const list = body.items ?? body.history ?? [];
		for (const [id, reason] of [
			["no-history", "terminal"],
			["invalid-start", "terminal"],
			["no-work", "terminal"],
		])
			expect(list.find((run) => run.id === id)).toMatchObject({
				expectedFinishAt: null,
				expectedFinishAtReason: reason,
			});
	}
});

it.each(["quick", "deep"] as const)(
	"matches browser/detail/machine ETA for small manual selected %s work, including historical wall overhead",
	async (depth) => {
		const s = await setup();
		const base = makeRun("plan", account, "owner", "plan", "catalog", [], now)
			.steps[0] as FactoryRunStep;
		await s.seed("large-history", {
			depth,
			trigger: "daily",
			status: "partial",
			startedAt: "2026-10-20T00:00:00.000Z",
			finishedAt: "2026-10-20T01:10:00.000Z",
			steps: [
				...Array.from({ length: 100 }, () => ({
					...base,
					kind: "metadata" as const,
					status: "success" as const,
					attempts: 1,
					durationMs: 1000,
				})),
				...Array.from({ length: 1000 }, () => ({
					...base,
					kind: "snapshot" as const,
					status: "limited" as const,
					attempts: 1,
					durationMs: 3000,
				})),
			],
		});
		const steps = [
			...Array.from({ length: 5 }, () => ({ ...base, kind: "metadata" as const })),
			...Array.from({ length: 50 }, () => ({ ...base, kind: "snapshot" as const })),
		];
		const selected = {
			depth,
			trigger: "manual" as const,
			selection: { scope: "selected" as const, repos: ["owner/app"] },
		};
		await s.seed("compact-target", {
			...selected,
			status: "failed",
			startedAt: "2026-10-21T00:00:00.000Z",
			steps,
		});
		await s.seed("manual-active", {
			...selected,
			status: "running",
			cursor: 1,
			steps: steps.map((step, index) => ({
				...step,
				status: index === 0 ? "success" : index === 20 ? "skipped" : "pending",
			})),
		});
		const before = await s.savedRows();
		const network = vi.fn();
		vi.stubGlobal("fetch", network);
		for (const [machine, history] of [
			[false, ""],
			[false, "compact-target"],
			[true, ""],
		] as const) {
			const response = await s.call(machine, history);
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				current?: RunJson;
				history?: RunJson[];
				items?: RunJson[];
			};
			const rows = body.items ?? [...(body.current ? [body.current] : []), ...(body.history ?? [])];
			expect(rows.find((run) => run.id === "manual-active")).toMatchObject({
				expectedFinishAt: "2026-10-22T00:03:24.000Z",
				expectedFinishAtReason: null,
			});
			const compact = rows.find((run) => run.id === "compact-target");
			expect(compact).toMatchObject({
				expectedFinishAt: null,
				expectedFinishAtReason: "terminal",
			});
			expect(compact?.steps).toHaveLength(history ? 55 : 0);
			for (const run of rows)
				for (const field of ["plans", "stepKinds", "stepPlan", "overhead"])
					expect(run).not.toHaveProperty(field);
		}
		for (const machine of [false, true]) {
			const latest = await s.latest(machine, depth);
			expect(latest.status).toBe(200);
			expect(await latest.json()).toMatchObject({
				id: "manual-active",
				kind: "manual",
				depth,
				expectedFinishAt: "2026-10-22T00:03:24.000Z",
				expectedFinishAtReason: null,
			});
		}
		expect(await s.savedRows()).toEqual(before);
		expect(network).not.toHaveBeenCalled();
	},
);

it("scales a large daily run up from a small manual selected history without borrowing another execution kind", async () => {
	const s = await setup();
	const base = makeRun("plan", account, "owner", "plan", "catalog", [], now)
		.steps[0] as FactoryRunStep;
	await s.seed("manual-history", {
		depth: "quick",
		trigger: "manual",
		selection: { scope: "selected", repos: ["owner/app"] },
		status: "completed",
		startedAt: "2026-10-20T00:00:00.000Z",
		finishedAt: "2026-10-20T00:00:12.000Z",
		steps: [1000, 3000, 5000].map((durationMs) => ({
			...base,
			kind: "metadata",
			status: "success",
			attempts: 1,
			durationMs,
		})),
	});
	await s.seed("daily", {
		depth: "quick",
		trigger: "daily",
		status: "running",
		steps: Array.from({ length: 1200 }, () => ({ ...base, kind: "activity" })),
	});
	await s.seed("deep", { depth: "deep", status: "failed" });
	for (const machine of [false, true]) {
		expect(await (await s.latest(machine, "daily")).json()).toMatchObject({
			id: "daily",
			expectedFinishAt: "2026-10-22T01:20:00.000Z",
		});
		const response = await s.call(machine);
		const body = (await response.json()) as {
			current?: RunJson;
			history?: RunJson[];
			items?: RunJson[];
		};
		const rows = body.items ?? [...(body.current ? [body.current] : []), ...(body.history ?? [])];
		expect(rows.find((run) => run.id === "daily")).toMatchObject({
			expectedFinishAt: "2026-10-22T01:20:00.000Z",
			expectedFinishAtReason: null,
		});
		expect(rows.find((run) => run.id === "deep")).toMatchObject({
			expectedFinishAt: null,
			expectedFinishAtReason: "terminal",
		});
	}
});

it.each(["completed", "failed", "partial", "cancelled"] as const)(
	"clears %s ETA on browser/machine lists, detail and latest without writes",
	async (status) => {
		for (const [kind, mode, depth, trigger] of [
			["catalog", "catalog", "deep", "manual"],
			["daily", "refresh", "quick", "daily"],
			["weekly", "refresh", "deep", "weekly"],
			["manual", "refresh", "deep", "manual"],
			["quick", "refresh", "quick", "manual"],
			["deep", "refresh", "deep", "manual"],
		] as const) {
			const fixture = await setup();
			const startedAt = "2026-10-23T21:00:44.000Z";
			const finishedAt = "2026-10-23T21:27:34.000Z";
			await fixture.seed("sample", {
				mode,
				depth,
				status: "completed",
				startedAt: "2026-10-20T21:00:44.000Z",
				finishedAt: "2026-10-20T22:00:44.000Z",
			});
			await fixture.seed("terminal", { mode, depth, trigger, status, startedAt, finishedAt });
			const before = await fixture.savedRows();
			const network = vi.fn();
			vi.stubGlobal("fetch", network);
			const expected = {
				id: "terminal",
				status,
				finishedAt,
				expectedFinishAt: null,
				expectedFinishAtReason: "terminal",
			};
			for (const machine of [false, true]) {
				const response = await fixture.call(machine);
				expect(response.status).toBe(200);
				const body = (await response.json()) as { items?: RunJson[]; history?: RunJson[] };
				expect((body.items ?? body.history)?.find((run) => run.id === "terminal")).toMatchObject(
					expected,
				);
				const latest = await fixture.latest(machine, kind);
				expect(latest.status).toBe(200);
				expect(await latest.json()).toMatchObject(expected);
			}
			const response = await fixture.call(false, "terminal");
			expect(response.status).toBe(200);
			const body = (await response.json()) as { history: RunJson[] };
			const detail = body.history.find((run) => run.id === "terminal");
			expect(detail).toMatchObject(expected);
			expect(detail?.steps.length).toBeGreaterThan(0);
			expect(await fixture.savedRows()).toEqual(before);
			expect(network).not.toHaveBeenCalled();
		}
	},
);
