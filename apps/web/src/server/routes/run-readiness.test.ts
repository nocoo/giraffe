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
const started = "2026-10-21T21:00:00.000Z";
type StoredRun = Partial<FactoryRun> & { publishedAt?: string | null };

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(now));
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function setup(active = true) {
	const raw = sqliteFixture();
	for (const id of [account, other])
		await raw
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?,?,'encrypted','fake',?,?,?)",
			)
			.bind(id, id, Number(active && id === account), now, now)
			.run();
	const mint = (scopes: ("app:read" | "agent:read" | "app:write")[]) =>
		createApiToken(createDb(raw), {
			accountId: account,
			label: "readiness-test",
			scopes,
			expiresInDays: 1,
			creator: "test@local",
		});
	const token = await mint(["app:read"]);
	const env = {
		DB: raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
	} as unknown as Env;
	const app = createApp();
	const call = (query = "?kind=daily", machine = true, bearer = token.token, selected = account) =>
		app.request(
			`http://localhost${machine ? `/api/v1/accounts/${selected}/refresh-runs/latest` : "/api/factory/runs/latest"}${query}`,
			{ headers: machine ? { authorization: `Bearer ${bearer}` } : {} },
			env,
		);
	async function seed(id: string, input: StoredRun = {}, createdAt = started) {
		const run = {
			...makeRun(id, account, "owner", id, "refresh", [], started),
			depth: "quick" as const,
			trigger: "daily" as const,
			status: "completed" as const,
			finishedAt: "2026-10-21T21:30:00.000Z",
			...input,
		};
		run.steps = input.steps ?? [
			{ ...(run.steps[0] as FactoryRunStep), status: "success", finishedAt: run.finishedAt },
		];
		await raw
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
			)
			.bind(id, run.account_id, id, run.status, JSON.stringify(run), started, createdAt, now)
			.run();
		return run;
	}
	const saved = async () => {
		const tables = await raw
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all<{ name: string }>();
		return Promise.all(
			tables.results.map(async ({ name }) => ({
				name,
				rows: (await raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results,
			})),
		);
	};
	return { raw, env, app, call, seed, saved, mint };
}

it("R9 fake-clock completed latest exposes the stored marker and activity window to both readers without writes", async () => {
	const s = await setup();
	const activityWindow = {
		since: "2026-10-20T21:00:00.000Z",
		until: started,
		first: false,
		gap: false,
	};
	await s.seed("done", { activityWindow, publishedAt: "2026-10-21T21:30:00.000Z" });
	const before = await s.saved();
	const network = vi.spyOn(globalThis, "fetch");
	for (const machine of [true, false]) {
		const response = await s.call("?kind=daily", machine);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toEqual({
			account_id: account,
			id: "done",
			kind: "daily",
			depth: "quick",
			status: "completed",
			window: activityWindow,
			startedAt: started,
			expectedFinishAt: "2026-10-21T21:30:00.000Z",
			expectedFinishAtReason: null,
			finishedAt: "2026-10-21T21:30:00.000Z",
			counts: { total: 1, success: 1, failed: 0, unavailable: 0, limited: 0, skipped: 0 },
			failedSteps: [],
			lastError: null,
			publishedAt: "2026-10-21T21:30:00.000Z",
			publishedAtReason: null,
		});
	}
	expect(await s.saved()).toEqual(before);
	expect(network).not.toHaveBeenCalled();
});

it("R9 fake-clock running latest reuses actual-kind median ETA and never exposes an active marker or recovers an expired deadline", async () => {
	const s = await setup();
	for (const [index, minutes] of [10, 20, 90].entries())
		await s.seed(`sample-${index}`, {
			startedAt: "2026-10-20T00:00:00.000Z",
			finishedAt: new Date(Date.parse("2026-10-20T00:00:00.000Z") + minutes * 60_000).toISOString(),
			trigger: "manual",
		});
	await s.seed("active", {
		status: "running",
		finishedAt: null,
		publishedAt: now,
		deadlineAt: "2026-10-21T22:00:00.000Z",
	});
	const before = await s.saved();
	for (const machine of [true, false]) {
		const response = await s.call("?kind=daily", machine);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			id: "active",
			status: "running",
			expectedFinishAt: "2026-10-21T21:20:00.000Z",
			expectedFinishAtReason: null,
			finishedAt: null,
			publishedAt: null,
		});
	}
	expect(await s.saved()).toEqual(before);
});

it.each([
	["quick", { trigger: "weekly", depth: "quick" }, "weekly"],
	["deep", { trigger: "daily", depth: "deep" }, "daily"],
	["quick", { trigger: "manual", depth: "quick" }, "manual"],
	["catalog", { mode: "catalog", trigger: "daily" }, "catalog"],
] as const)(
	"R9 browser and machine %s filters return the canonical kind and nonactivity collection window",
	async (kind, input, canonicalKind) => {
		const s = await setup();
		const run = await s.seed("nonactivity", input);
		for (const machine of [true, false]) {
			const response = await s.call(`?kind=${kind}`, machine);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				id: run.id,
				kind: canonicalKind,
				window: run.window,
			});
		}
	},
);

it("R9 fake-clock failed latest returns safe failed-step summary, fallback error, all outcome counts and no marker", async () => {
	const s = await setup();
	const base = makeRun("base", account, "owner", "base", "catalog", [], started).steps[0];
	const steps = ["success", "failed", "unavailable", "limited", "skipped"] as const;
	await s.seed("failed", {
		status: "failed",
		publishedAt: now,
		steps: steps.map((status) => ({
			...(base as FactoryRunStep),
			kind: "snapshot",
			repo: "owner/repo",
			resource: "repo:owner/repo:security",
			status,
			error: status === "failed" ? "snapshot_incomplete" : null,
		})),
	});
	const response = await s.call();
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		status: "failed",
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
		publishedAt: null,
		expectedFinishAt: null,
		expectedFinishAtReason: "no_completed_history",
	});
});

it.each(["", "?kind=unknown", "?kind=daily&kind=weekly", "?kind=daily&x=1"])(
	"R9 latest rejects missing, unsupported, duplicate and unknown query keys: %s",
	async (query) => {
		const s = await setup();
		for (const machine of [true, false]) {
			const response = await s.call(query, machine);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
		}
	},
);

it("R9 latest preserves bearer app-read/account and browser active-account/Access boundaries", async () => {
	const s = await setup();
	await s.seed("current");
	for (const scopes of [["agent:read"], ["app:write"]] as const) {
		const token = await s.mint([...scopes]);
		expect((await s.call("?kind=daily", true, token.token)).status).toBe(403);
	}
	expect((await s.call("?kind=invalid", true, "invalid")).status).toBe(401);
	expect((await s.call("?kind=daily", true, undefined, other)).status).toBe(403);
	expect((await (await setup(false)).call("?kind=daily", false)).status).toBe(409);
	expect(
		(
			await s.app.request(
				"http://localhost/api/factory/runs/latest?kind=daily",
				{},
				{ ...s.env, ENVIRONMENT: "production" },
			)
		).status,
	).toBe(401);
	for (const machine of [true, false]) {
		const response = await s.call("?kind=weekly", machine);
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
	}
	for (const method of ["POST", "HEAD"]) {
		const token = await s.mint(["app:read", "app:write"]);
		expect(
			(
				await s.app.request(
					`http://localhost/api/v1/accounts/${account}/refresh-runs/latest?kind=daily`,
					{
						method,
						headers: { authorization: `Bearer ${token.token}` },
					},
					s.env,
				)
			).status,
		).toBe(405);
	}
	expect(
		(
			await s.app.request(
				"http://localhost/api/factory/runs/latest?kind=daily",
				{ method: "POST", headers: { origin: "http://localhost" } },
				s.env,
			)
		).status,
	).toBe(405);
});
