import { readFileSync } from "node:fs";
import { transformWithOxc } from "vite";
import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { sqliteFixture } from "../../../../tests/fixtures/sqlite";
import { type Env, encryptionKey } from "./env";
import { getAccount } from "./lib/db/accounts";
import { createDb } from "./lib/db/d1";
import { ApiError, jsonError } from "./lib/errors";
import { createId } from "./lib/id";
import { parseRefreshParams, refreshDays } from "./lib/refresh-params";
import { getRefreshRun } from "./lib/refresh-store";
import { decryptToken, encryptToken, parseKeyBytes } from "./lib/token-crypto";
import { RefreshRunner, startRefresh } from "./refresh-runner";

const collectors = vi.hoisted(() => ({ collectAccount: vi.fn(), collectRepository: vi.fn() }));
vi.mock("./lib/refresh-collection", () => collectors);

type LegacyRunner = new (state: DurableObjectState, env: Env) => { alarm: () => Promise<void> };

async function legacyModule(
	path: string,
	exportNames: string[],
	bindings: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const source = readFileSync(path, "utf8")
		.replace(/^import[\s\S]*?;\s*/gm, "")
		.replace(/\bexport\s+/g, "");
	const { code } = await transformWithOxc(source, "legacy-refresh.ts", { lang: "ts" });
	return new Function(...Object.keys(bindings), `${code}\nreturn { ${exportNames.join(",")} };`)(
		...Object.values(bindings),
	) as Record<string, unknown>;
}

const legacyStore = await legacyModule(
	"tests/fixtures/refresh-0270-store.txt",
	["activeRefreshRun", "createRefreshRun", "saveRefreshRun", "scheduledRefreshRun"],
	{ createId },
);
const legacyRunner = await legacyModule(
	"tests/fixtures/refresh-0270-runner.txt",
	["RefreshRunner"],
	{
		z,
		encryptionKey,
		getAccount,
		createDb,
		ApiError,
		jsonError,
		parseRefreshParams,
		refreshDays,
		decryptToken,
		parseKeyBytes,
		collectAccount: (context: unknown) => collectors.collectAccount(context),
		collectRepository: (context: unknown, repo: string) =>
			collectors.collectRepository(context, repo),
		...legacyStore,
	},
);
const LegacyRefreshRunner = legacyRunner.RefreshRunner as LegacyRunner;

const collected = (requests: number, graphql: number, rest: number, reasons: string[] = []) => ({
	requests,
	requestBreakdown: { graphql, rest },
	partial: reasons.length > 0,
	reasons,
});

beforeEach(() => {
	collectors.collectAccount.mockReset().mockResolvedValue({
		repos: ["octo/one", "octo/two"],
		...collected(1, 1, 0),
	});
	collectors.collectRepository.mockReset().mockResolvedValue(collected(3, 1, 2));
});

async function setup() {
	const raw = sqliteFixture();
	const token = `ghp_${"T".repeat(36)}`;
	const ciphertext = await encryptToken(token, parseKeyBytes("0".repeat(64)));
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,key_version,created_at,updated_at) VALUES('account','octo',?,'TTTT',1,'t','t')",
		)
		.bind(ciphertext)
		.run();
	const values = new Map<string, unknown>();
	let alarm: number | null = null;
	const storage = {
		get: vi.fn(async (key: string) => values.get(key)),
		put: vi.fn(async (key: string, value: unknown) => {
			values.set(key, value);
		}),
		delete: vi.fn(async (key: string) => values.delete(key)),
		getAlarm: vi.fn(async () => alarm),
		setAlarm: vi.fn(async (at: number) => {
			alarm = at;
		}),
		deleteAlarm: vi.fn(async () => {
			alarm = null;
		}),
	};
	let lock: Promise<unknown> = Promise.resolve();
	const state = {
		storage,
		blockConcurrencyWhile: <Value>(fn: () => Promise<Value>) => {
			const next = lock.then(fn);
			lock = next.catch(() => {});
			return next;
		},
	} as unknown as DurableObjectState;
	const env = {
		DB: raw,
		TOKEN_ENCRYPTION_KEY_V1: "0".repeat(64),
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
	} as unknown as Env;
	const runner = new RefreshRunner(state, env);
	env.REFRESH_RUNNER = {
		getByName: vi.fn(() => ({ fetch: (request: Request) => runner.fetch(request) })),
	} as unknown as DurableObjectNamespace;
	const legacy = new LegacyRefreshRunner(state, env);
	const db = () => createDb(raw);
	const stored = (id: string) =>
		raw
			.prepare(
				"SELECT status,payload,updated_at,writer_revision FROM refresh_runs WHERE account_id='account' AND id=?",
			)
			.bind(id)
			.first<{
				status: string;
				payload: string;
				updated_at: string;
				writer_revision: number;
			}>();
	return {
		raw,
		env,
		legacy,
		runner,
		db,
		stored,
	};
}

it("fences the frozen 0.27.0 alarm before collection and leaves the modern alarm authoritative", async () => {
	const fixture = await setup();
	const run = await startRefresh(fixture.env, "account", {});
	const queued = await getRefreshRun(fixture.db(), "account", run.id);
	expect(queued?.status).toBe("queued");
	await expect(fixture.legacy.alarm()).rejects.toMatchObject({ code: "db_error" });
	expect(collectors.collectAccount).not.toHaveBeenCalled();
	expect(collectors.collectRepository).not.toHaveBeenCalled();
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toEqual(queued);
	expect(await fixture.stored(run.id)).toMatchObject({
		status: "queued",
		writer_revision: 0,
	});
	let releaseRepository: ((value: unknown) => void) | undefined;
	collectors.collectRepository
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseRepository = resolve as (value: unknown) => void;
				}),
		)
		.mockResolvedValue(collected(3, 1, 2));
	const step = fixture.runner.alarm();
	await vi.waitFor(() => expect(releaseRepository).toBeTypeOf("function"));
	const afterAccount = async () => fixture.stored(run.id);
	expect(collectors.collectAccount).toHaveBeenCalledOnce();
	const accountStep = await afterAccount();
	expect(accountStep).toMatchObject({ status: "running", writer_revision: 2 });
	expect(JSON.parse(accountStep?.payload ?? "{}")).toMatchObject({
		phase: "repos",
		requests: 1,
		requestBreakdown: { total: 1, graphql: 1, rest: 0, a: { graphql: 1, rest: 0 } },
		partialReasons: [],
	});
	await expect(fixture.legacy.alarm()).rejects.toMatchObject({ code: "db_error" });
	expect(await afterAccount()).toEqual(accountStep);
	releaseRepository?.(collected(3, 1, 2, ["actions:unavailable"]));
	await step;
	expect(collectors.collectRepository).toHaveBeenCalledTimes(2);
	expect(await getRefreshRun(fixture.db(), "account", run.id)).toMatchObject({
		status: "partial",
		phase: "done",
		completedRepos: 2,
		requests: 7,
		requestBreakdown: {
			total: 7,
			graphql: 3,
			rest: 4,
			a: { graphql: 1, rest: 0 },
			b: { graphql: 2, rest: 4 },
		},
		partialReasons: [{ repo: "octo/one", codes: ["actions:unavailable"] }],
		cancelRequested: false,
	});
	expect(await fixture.stored(run.id)).toMatchObject({
		status: "partial",
		writer_revision: 4,
	});
});
