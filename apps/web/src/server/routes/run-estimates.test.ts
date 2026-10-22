import { afterEach, expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { type FactoryRun, makeRun } from "../../lib/factory-run";
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

afterEach(() => vi.unstubAllGlobals());

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
	return { raw, seed, call, savedRows };
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
			expect(run).toHaveProperty("expectedFinishAtReason", null);
			expect(run).not.toHaveProperty("checkpoint");
		}
		expect(list.find((run) => run.id === "current")).toMatchObject({
			expectedFinishAt: "2026-10-21T00:00:30.000Z",
		});
		expect(list.find((run) => run.id === "failed-21")).toMatchObject({
			steps: [],
			expectedFinishAt: "2026-10-21T00:00:30.000Z",
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

it("includes every null reason on compact browser and machine entries without historical samples", async () => {
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
			["no-history", "no_completed_history"],
			["invalid-start", "invalid_started_at"],
			["no-work", "not_executed"],
		])
			expect(list.find((run) => run.id === id)).toMatchObject({
				expectedFinishAt: null,
				expectedFinishAtReason: reason,
			});
	}
});
