import { afterEach, expect, it, vi } from "vitest";
import { refreshGraphqlStub } from "../../../../scripts/refresh-stub";
import { sqliteFixture } from "../../../../tests/fixtures/sqlite";
import type { RefreshRun } from "../lib/refresh-types";
import type { Env } from "./env";
import { createDb } from "./lib/db/d1";
import * as collection from "./lib/refresh-collection";
import { getRefreshRun } from "./lib/refresh-store";
import { encryptToken, parseKeyBytes } from "./lib/token-crypto";
import { RefreshRunner, startRefresh } from "./refresh-runner";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it("finishes a real force A/serial B despite slow D1 and reuses unavailable alert days with zero requests", async () => {
	vi.useFakeTimers({ now: new Date("2026-10-29T04:00:00.000Z"), toFake: ["Date"] });
	const raw = sqliteFixture();
	const ciphertext = await encryptToken("memory-only-fake-token", parseKeyBytes("0".repeat(64)));
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,key_version,created_at,updated_at) VALUES('account','phase2',?,'test',1,'t','t')",
		)
		.bind(ciphertext)
		.run();
	const calls: string[][] = [];
	const originals = new WeakMap<
		D1PreparedStatement,
		{ statement: D1PreparedStatement; sql: string }
	>();
	const observe = (queries: string[]) => {
		calls.push(queries);
		vi.setSystemTime(Date.now() + 3_000);
	};
	const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
		const wrapped = {
			bind: (...values: unknown[]) => wrap(statement.bind(...values), sql),
			first: async <Result>() => {
				observe([sql]);
				return statement.first<Result>();
			},
			all: async <Result>() => {
				observe([sql]);
				return statement.all<Result>();
			},
			run: async () => {
				observe([sql]);
				return statement.run();
			},
		} as D1PreparedStatement;
		originals.set(wrapped, { statement, sql });
		return wrapped;
	};
	const db = {
		prepare: (sql: string) => wrap(raw.prepare(sql), sql),
		batch: async (statements: D1PreparedStatement[]) => {
			const entries = statements.map((statement) => {
				const entry = originals.get(statement);
				if (!entry) throw new Error("Foreign D1 statement");
				return entry;
			});
			observe(entries.map((entry) => entry.sql));
			return raw.batch(entries.map((entry) => entry.statement));
		},
	} as D1Database;
	const upstream = vi.fn(async (input: string, init?: RequestInit) => {
		vi.setSystemTime(Date.now() + 100);
		if (input.endsWith("/graphql")) {
			const { query, variables } = JSON.parse(String(init?.body)) as {
				query: string;
				variables: Record<string, unknown>;
			};
			const result = refreshGraphqlStub(query, variables, "phase2");
			if (!result) throw new Error("Unexpected GraphQL query");
			if ("viewer" in result.data && result.data.viewer) {
				const viewer = result.data.viewer;
				return Response.json({
					data: {
						...result.data,
						viewer: {
							...viewer,
							repositories: {
								...viewer.repositories,
								nodes: variables.after ? [] : viewer.repositories.nodes,
								pageInfo: {
									hasNextPage: !variables.after,
									endCursor: variables.after ? null : "next",
								},
							},
						},
					},
				});
			}
			return Response.json(result);
		}
		if (input.includes("/alerts")) return Response.json({ message: "Not Found" }, { status: 404 });
		if (input.includes("/actions/runs"))
			return Response.json({ total_count: 0, workflow_runs: [] });
		throw new Error("Unexpected REST request");
	});
	vi.stubGlobal("fetch", upstream);
	let alarm: number | null = null;
	const values = new Map<string, unknown>();
	const state = {
		storage: {
			get: async (key: string) => values.get(key),
			put: async (key: string, value: unknown) => {
				values.set(key, value);
			},
			delete: async (key: string) => values.delete(key),
			getAlarm: async () => alarm,
			setAlarm: async (at: number) => {
				alarm = at;
			},
			deleteAlarm: async () => {
				alarm = null;
			},
		},
		blockConcurrencyWhile: <Value>(operation: () => Promise<Value>) => operation(),
	} as unknown as DurableObjectState;
	const env = {
		DB: db,
		ENVIRONMENT: "test",
		GITHUB_API_BASE: "http://github.test",
		TOKEN_ENCRYPTION_KEY_V1: "0".repeat(64),
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
	} as unknown as Env;
	const runner = new RefreshRunner(state, env);
	const spans: { phase: string; started: number; finished: number }[] = [];
	async function measure<Value>(phase: string, operation: () => Promise<Value>): Promise<Value> {
		const span = { phase, started: Date.now(), finished: Date.now() };
		spans.push(span);
		try {
			return await operation();
		} finally {
			span.finished = Date.now();
		}
	}
	const collectAccount = collection.collectAccount;
	const collectRepository = collection.collectRepository;
	vi.spyOn(collection, "collectAccount").mockImplementation((context) =>
		measure("a", () => collectAccount(context)),
	);
	vi.spyOn(collection, "collectRepository").mockImplementation((context, repo) =>
		measure("b", () => collectRepository(context, repo)),
	);
	env.REFRESH_RUNNER = {
		getByName: () => ({ fetch: (request: Request) => runner.fetch(request) }),
	} as unknown as DurableObjectNamespace;
	const results: {
		force: boolean;
		d1Calls: number;
		wallMs: number;
		requests: number;
		collectorGapMs: number | null;
	}[] = [];
	let securityEvidence: unknown;
	for (const force of [true, false]) {
		const started = Date.now();
		calls.length = 0;
		spans.length = 0;
		upstream.mockClear();
		const run = await startRefresh(env, "account", { repo: "phase2/demo", force });
		await runner.alarm();
		const saved = (await getRefreshRun(createDb(raw), "account", run.id)) as RefreshRun;
		expect(saved.status).toBe("completed");
		expect(saved.partialReasons).toEqual([]);
		expect(saved.requestBreakdown).toMatchObject({
			a: { graphql: force ? 2 : 0, rest: 0 },
			b: { graphql: force ? 1 : 1, rest: force ? 3 : 0 },
		});
		expect(upstream).toHaveBeenCalledTimes(force ? 6 : 1);
		expect(alarm).toBeNull();
		expect(Date.now() - started).toBeGreaterThan(25_000);
		expect(calls.length).toBeLessThanOrEqual(force ? 23 : 21);
		expect(Date.now() - started).toBeLessThanOrEqual(force ? 70_000 : 65_000);
		const security = await raw
			.prepare(
				"SELECT payload,fetched_at FROM refresh_snapshots WHERE account_id='account' AND kind='repo:phase2/demo:security'",
			)
			.first<{ payload: string; fetched_at: string }>();
		expect(JSON.parse(security?.payload ?? "{}")).toMatchObject({
			unavailable: true,
			dependabot_open: null,
			code_scanning_open: null,
			features: {
				dependabot: { status: "unavailable", reason_code: "not_found" },
				code_scanning: { status: "unavailable", reason_code: "not_found" },
			},
		});
		if (force) securityEvidence = security;
		else expect(security).toEqual(securityEvidence);
		const accountSpan = spans.find((span) => span.phase === "a");
		const repositorySpan = spans.find((span) => span.phase === "b");
		expect(repositorySpan).toBeDefined();
		const collectorGapMs =
			accountSpan && repositorySpan ? repositorySpan.started - accountSpan.finished : null;
		if (force) expect(collectorGapMs).toBeLessThanOrEqual(12_000);
		results.push({
			force,
			d1Calls: calls.length,
			wallMs: Date.now() - started,
			requests: saved.requests,
			collectorGapMs,
		});
	}
	if (process.env.GIRAFFE_REFRESH_PROFILE === "1")
		console.log("REFRESH_D1_PROFILE", JSON.stringify(results));
});
