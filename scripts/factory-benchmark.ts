import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types/index.ts";
import type { FactoryRun } from "../apps/web/src/lib/factory-run";
import type { FactoryRepo } from "../apps/web/src/lib/factory-types";
import { factoryFixture } from "../tests/fixtures/factory-snapshot";
import { factoryGraphqlStub, factoryRepoStub } from "./factory-stub";

const START = Date.parse("2026-10-23T04:00:00+08:00");
const DAY = 86_400_000;
const ORIGIN = "https://factory-benchmark.invalid";
const KEY = "0".repeat(64);
const ACCOUNT = "benchmark-account";

export class BenchmarkClock {
	private pending: { at: number; finish: () => void }[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private external = 0;
	constructor(public now: number) {}

	iso = () => new Date(this.now).toISOString();

	track<Result>(operation: Promise<Result>) {
		this.external++;
		return operation.finally(() => {
			this.external--;
		});
	}

	sleep(milliseconds: number) {
		return new Promise<void>((finish) => {
			this.pending.push({ at: this.now + milliseconds, finish });
			this.schedule();
		});
	}

	private schedule() {
		if (this.timer || !this.pending.length) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.external) {
				this.schedule();
				return;
			}
			this.now = Math.max(this.now, Math.min(...this.pending.map((item) => item.at)));
			const ready = this.pending.filter((item) => item.at <= this.now);
			this.pending = this.pending.filter((item) => item.at > this.now);
			for (const item of ready) item.finish();
			this.schedule();
		}, 1);
	}
}

type Category =
	| "issues"
	| "prs"
	| "actions-stream"
	| "actions-snapshot"
	| "actions-deploy"
	| "snapshot"
	| "other";

export function benchmarkLatency(category: Category) {
	const actionPageMs = 42_700 / 13;
	return {
		issues: 246_000 / (60 * 3),
		prs: 391_000 / (60 * 3 * 2),
		"actions-stream": 428_000 / 127,
		"actions-snapshot": actionPageMs,
		"actions-deploy": actionPageMs,
		snapshot: (1_071_000 - 127 * actionPageMs) / (60 * 8),
		other: 300,
	}[category];
}

function actionPages(index: number) {
	const slot = index % 60;
	return slot < 34 ? 1 : slot < 58 ? 3 : slot === 58 ? 8 : 13;
}

function repository(index: number) {
	const name = `bench-${String(index).padStart(3, "0")}`;
	return {
		...factoryRepoStub,
		id: `R_${name}`,
		name,
		nameWithOwner: `octocat/${name}`,
		url: `https://github.com/octocat/${name}`,
		pushedAt: new Date(START - 7 * DAY).toISOString(),
		closedIssues: { totalCount: 3 },
		closedPrs: { totalCount: 3 },
	};
}

type RequestMetric = { requests: number; serviceMs: number };
type BenchmarkDb = Pick<D1Database, "prepare" | "batch">;
type BenchmarkEnv = {
	DB: D1Database;
	ENVIRONMENT: string;
	GITHUB_API_BASE: string;
	TOKEN_ENCRYPTION_KEY_V1: string;
};

export function benchmarkGithub(clock: BenchmarkClock, count: number) {
	const repos = Array.from({ length: count }, (_, index) => repository(index));
	let metrics: Partial<Record<Category, RequestMetric>> = {};
	const unsupported: string[] = [];
	function respond(category: Category, body: unknown, next?: URL) {
		const serviceMs = benchmarkLatency(category);
		metrics[category] ??= { requests: 0, serviceMs: 0 };
		const metric = metrics[category];
		metric.requests++;
		metric.serviceMs += serviceMs;
		return clock.sleep(serviceMs).then(() =>
			Response.json(body, {
				headers: next ? { link: `<${next.href}>; rel="next"` } : {},
			}),
		);
	}

	const fetch = async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== ORIGIN) {
			unsupported.push(`origin:${url.origin}`);
			throw new Error("Benchmark refuses non-fixture network destinations");
		}
		if (url.pathname === "/graphql") {
			const { query, variables = {} } = JSON.parse(String(init?.body)) as {
				query: string;
				variables?: Record<string, unknown>;
			};
			if (query.includes("repositories(")) {
				const offset = Number(variables.after ?? 0);
				const size = query.includes("first:10,") ? 10 : 100;
				return respond("other", {
					data: {
						viewer: {
							login: "octocat",
							repositories: {
								totalCount: count,
								nodes: repos.slice(offset, offset + size),
								pageInfo: { hasNextPage: offset + size < count, endCursor: String(offset + size) },
							},
						},
					},
				});
			}
			if (query.includes("openPrs:")) {
				const repo = repos.find((item) => item.name === variables.name);
				if (!repo) throw new Error("Unknown benchmark repository");
				return respond("other", { data: { repository: repo } });
			}
			if (query.includes("nodes(ids:"))
				return respond("prs", {
					data: {
						nodes: (variables.ids as string[]).map((id) => ({
							id,
							mergeable: "MERGEABLE",
							mergeStateStatus: "CLEAN",
							commits: { nodes: [] },
							baseRefName: "main",
						})),
					},
				});
			if (query.includes("search("))
				return respond("other", {
					data: { search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } } },
				});
			if (query.includes("vulnerabilityAlerts"))
				return respond("snapshot", {
					data: {
						repository: { vulnerabilityAlerts: { nodes: [], pageInfo: { hasNextPage: false } } },
					},
				});
			const reused = factoryGraphqlStub(query, variables);
			if (reused) return respond("other", reused);
			unsupported.push(`graphql:${query.slice(0, 100)}`);
			throw new Error("Unsupported benchmark GraphQL request");
		}
		if (url.pathname === "/notifications") return respond("other", []);
		const match = /^\/repos\/octocat\/bench-(\d+)(.*)$/.exec(url.pathname);
		const index = Number(match?.[1]);
		const repo = match ? repos[index] : undefined;
		if (!repo) {
			unsupported.push(url.pathname);
			throw new Error("Unknown benchmark REST request");
		}
		const suffix = match?.[2];
		if (!suffix) return respond("snapshot", { default_branch: "main", html_url: repo.url });
		if (suffix === "/languages") return respond("snapshot", { TypeScript: 100 });
		if (suffix === "/traffic/views" || suffix === "/traffic/clones")
			return respond("snapshot", { count: 0, uniques: 0, views: [], clones: [] });
		if (suffix === "/code-scanning/alerts") return respond("snapshot", []);
		if (suffix === "/dependabot/alerts" || suffix === "/commits") return respond("other", []);
		if (suffix === "/contributors" || suffix === "/releases")
			return respond(url.searchParams.has("page") ? "other" : "snapshot", []);
		if (["/issues", "/pulls", "/actions/runs"].includes(String(suffix))) {
			const actions = suffix === "/actions/runs";
			const pages = actions ? actionPages(index) : 3;
			const since = url.searchParams.get("since");
			const rows = Array.from({ length: pages }, (_, offset) => {
				const at = new Date(START - (offset === 0 ? 2 / 24 : offset + 2) * DAY).toISOString();
				return {
					id: index * 100 + offset + 1,
					node_id: `N_${index}_${offset}`,
					number: offset + 1,
					title: "Synthetic closed item",
					name: "ci",
					html_url: `${repo.url}/${actions ? "actions/runs" : "issues"}/${offset + 1}`,
					state: "closed",
					status: "completed",
					conclusion: "success",
					event: "push",
					head_branch: "main",
					head_sha: "abc",
					created_at: at,
					updated_at: at,
					closed_at: at,
					user: { login: "octocat" },
				};
			}).filter((row) => row.created_at <= clock.iso() && (!since || row.updated_at >= since));
			const range = url.searchParams.get("created")?.split("..");
			const filtered = rows.filter(
				(row) =>
					!range || (row.created_at >= String(range[0]) && row.created_at <= String(range[1])),
			);
			const page = Number(url.searchParams.get("page") ?? 1);
			const next =
				page < filtered.length
					? new URL(`${url.pathname}${url.search}`, "https://api.github.com")
					: undefined;
			next?.searchParams.set("page", String(page + 1));
			const category = actions
				? url.searchParams.has("created")
					? "actions-stream"
					: url.searchParams.has("status")
						? "actions-deploy"
						: "actions-snapshot"
				: suffix === "/issues"
					? "issues"
					: "prs";
			const items = filtered.slice(page - 1, page);
			return respond(
				category,
				actions ? { total_count: filtered.length, workflow_runs: items } : items,
				next,
			);
		}
		unsupported.push(url.pathname);
		throw new Error("Unsupported benchmark REST request");
	};
	return {
		fetch: Object.assign(fetch, {
			preconnect: () => {
				throw new Error("Benchmark refuses preconnect");
			},
		}),
		repos,
		unsupported,
		metrics: () => metrics,
		reset: () => {
			metrics = {};
		},
	};
}

function sourceHash(root: string) {
	const hash = createHash("sha256");
	function visit(directory: string) {
		for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true }).sort(
			(left, right) => left.name.localeCompare(right.name),
		)) {
			const path = `${directory}/${entry.name}`;
			if (entry.isDirectory()) visit(path);
			else if (/\.(ts|sql)$/.test(path) && !path.includes(".test."))
				hash.update(path).update(readFileSync(resolve(root, path)));
		}
	}
	visit("apps/web/src/server");
	visit("apps/web/src/lib");
	hash.update(readFileSync(resolve(root, "package.json")));
	return hash.digest("hex");
}

export async function runBenchmark(
	options: {
		repos?: number;
		warm?: boolean;
		source?: string;
		label?: string;
		selection?: "all" | "selected";
	} = {},
) {
	const count = options.repos ?? 60;
	if (!Number.isInteger(count) || count < 1 || count > 120)
		throw new Error("repos must be between 1 and 120");
	const source = resolve(options.source ?? process.cwd());
	const load = (path: string) => import(pathToFileURL(resolve(source, path)).href);
	const { makeRun } = (await load(
		"apps/web/src/lib/factory-run.ts",
	)) as typeof import("../apps/web/src/lib/factory-run");
	const { executeRunPage } = (await load("apps/web/src/server/lib/factory-execute.ts")) as {
		executeRunPage: (env: BenchmarkEnv, id: string, clock: () => string) => Promise<string | null>;
	};
	const { createDb } = (await load("apps/web/src/server/lib/db/d1.ts")) as {
		createDb: (raw: D1Database) => BenchmarkDb;
	};
	const { startRun, getRun } = (await load("apps/web/src/server/lib/db/factory-runs.ts")) as {
		startRun: (db: BenchmarkDb, run: FactoryRun, clock: () => string) => Promise<FactoryRun>;
		getRun: (db: BenchmarkDb, account: string, id: string) => Promise<{ run: FactoryRun } | null>;
	};
	const { replaceSnapshotStmts } = (await load("apps/web/src/server/lib/db/snapshots.ts")) as {
		replaceSnapshotStmts: (
			db: BenchmarkDb,
			account: string,
			kind: string,
			payload: Record<string, unknown>,
			now: string,
		) => Promise<D1PreparedStatement[]>;
	};
	const { mapFactoryRepo } = (await load("apps/web/src/server/lib/factory-map.ts")) as {
		mapFactoryRepo: (raw: Record<string, unknown>) => FactoryRepo;
	};
	const { encryptToken, parseKeyBytes } = (await load(
		"apps/web/src/server/lib/token-crypto.ts",
	)) as {
		encryptToken: (token: string, key: Uint8Array) => Promise<string>;
		parseKeyBytes: (key: string) => Uint8Array;
	};
	const { sqliteFixture } = (await load("tests/fixtures/sqlite.ts")) as {
		sqliteFixture: () => D1Database;
	};
	const originalDirectory = process.cwd();
	const originalFetch = globalThis.fetch;
	const originalNow = Date.now;
	const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
	const nativeCrypto = globalThis.crypto;
	const clock = new BenchmarkClock(START - (options.warm === false ? 0 : DAY));
	const github = benchmarkGithub(clock, count);
	const hash = sourceHash(source);
	process.chdir(source);
	globalThis.fetch = github.fetch;
	Date.now = () => clock.now;
	const subtle = new Proxy(nativeCrypto.subtle, {
		get(target, key) {
			const value = Reflect.get(target, key, target);
			return typeof value === "function"
				? (...args: unknown[]) => clock.track(Promise.resolve(Reflect.apply(value, target, args)))
				: value;
		},
	});
	Object.defineProperty(globalThis, "crypto", {
		configurable: true,
		value: new Proxy(nativeCrypto, {
			get(target, key) {
				if (key === "subtle") return subtle;
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}),
	});
	try {
		const raw = sqliteFixture();
		const env = {
			DB: raw,
			ENVIRONMENT: "development",
			GITHUB_API_BASE: ORIGIN,
			TOKEN_ENCRYPTION_KEY_V1: KEY,
		};
		await raw
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at,capabilities) VALUES(?,?,?,?,?,?,?)",
			)
			.bind(
				ACCOUNT,
				"octocat",
				await encryptToken("fake", parseKeyBytes(KEY)),
				"fake",
				clock.iso(),
				clock.iso(),
				JSON.stringify({ repo: true, notifications: true }),
			)
			.run();
		const seedDb = createDb(raw);
		await seedDb.batch(
			await replaceSnapshotStmts(
				seedDb,
				ACCOUNT,
				"repos",
				{
					repos: github.repos.map((repo) => ({ name_with_owner: repo.nameWithOwner, id: repo.id })),
					truncated: false,
				},
				clock.iso(),
			),
		);
		const repos = github.repos.map(mapFactoryRepo);
		await seedDb.batch(
			await replaceSnapshotStmts(
				seedDb,
				ACCOUNT,
				"factory",
				{
					...factoryFixture(),
					account_id: ACCOUNT,
					owner: "octocat",
					runId: clock.iso(),
					startedAt: clock.iso(),
					fetched_at: clock.iso(),
					window: { since: new Date(clock.now - 90 * DAY).toISOString(), until: clock.iso() },
					inventory: {
						total: count,
						scanned: count,
						complete: true,
						after: null,
						pages: Math.ceil(count / 10),
						excluded: [],
					},
					repos,
				},
				clock.iso(),
			),
		);
		async function measure(id: string) {
			github.reset();
			const started = clock.now;
			const run = makeRun(
				id,
				ACCOUNT,
				"octocat",
				id,
				"refresh",
				repos,
				clock.iso(),
				[],
				repos.map((repo) => repo.name),
				{ scope: options.selection ?? "all", repos: repos.map((repo) => repo.name) },
				"quick",
				true,
			);
			run.trigger = "daily";
			run.schedule = { kind: "daily", dueAt: clock.iso() };
			await raw
				.prepare(
					"INSERT INTO refresh_schedules(account_id,kind,enabled,time,weekday,scope,next_at) VALUES(?,'daily',1,'04:00',0,'all',?) ON CONFLICT(account_id,kind) DO UPDATE SET next_at=excluded.next_at",
				)
				.bind(ACCOUNT, clock.iso())
				.run();
			await startRun(createDb(raw), run, clock.iso);
			let saved: FactoryRun | null = run;
			let invocations = 0;
			let waitingMs = 0;
			while (saved?.status === "running") {
				if (++invocations > 3000) throw new Error("Benchmark exceeded 3000 invocations");
				const next = await executeRunPage(env, id, clock.iso);
				saved = (await getRun(createDb(raw), ACCOUNT, id))?.run ?? null;
				if (!saved) throw new Error("Benchmark run disappeared");
				if (github.unsupported.length) throw new Error(JSON.stringify(github.unsupported));
				if (saved.status !== "running") break;
				if (!next) throw new Error(`Unexpected dead invocation ${id} at cursor ${saved.cursor}`);
				const wait = Math.max(0, Date.parse(next) - clock.now);
				waitingMs += wait;
				clock.now += wait;
			}
			if (!saved) throw new Error("Missing final benchmark run");
			const failures = saved.steps.filter((step) => step.status !== "success");
			if (failures.length)
				throw new Error(
					JSON.stringify(
						failures.map(({ kind, resource, repo, status, error }) => ({
							kind,
							resource,
							repo,
							status,
							error,
						})),
					),
				);
			const requestsByCategory = github.metrics();
			const observedRequests = Object.values(requestsByCategory).reduce(
				(sum, metric) => sum + metric.requests,
				0,
			);
			if (saved.requests !== observedRequests)
				throw new Error(
					`Request mismatch: journal=${saved.requests}, observed=${observedRequests}`,
				);
			return {
				status: saved.status,
				published: Boolean(saved.publishedAt),
				steps: saved.steps.length,
				stepStatuses: { success: saved.steps.length },
				invocations,
				persistedInvocations: saved.invocations,
				requests: saved.requests,
				observedRequests,
				simulatedWallMs: Math.round(clock.now - started),
				simulatedMinutes: Number(((clock.now - started) / 60_000).toFixed(3)),
				waitingMs: Math.round(waitingMs),
				serialServiceMs: Math.round(
					Object.values(requestsByCategory).reduce((sum, metric) => sum + metric.serviceMs, 0),
				),
				requestsByCategory,
				stepDurationMs: Math.round(saved.steps.reduce((sum, step) => sum + step.durationMs, 0)),
			};
		}
		const warmup = options.warm === false ? null : await measure("benchmark-previous-day");
		clock.now = START;
		const measured = await measure("benchmark-daily");
		if (sourceHash(source) !== hash)
			throw new Error("Source changed during benchmark; rerun on a frozen snapshot");
		return {
			profile: "b14a-60-repo-v1",
			label: options.label ?? "working-tree",
			source,
			sourceSha256: hash,
			harnessSha256: createHash("sha256")
				.update(readFileSync(new URL(import.meta.url)))
				.digest("hex"),
			repos: count,
			selection: options.selection ?? "all",
			assumptions: [
				"Real executeRunPage, makeRun, startRun, publication and SQLite; no HTTP server or network.",
				"Warm mode executes the previous daily first; its requests/time are excluded from measured.",
				"One synthetic row per linked page; issues/PRs have 3 pages, sorted updated descending; since filters are honored.",
				"Actions per 60 repos: 34x1, 24x3, 1x8, 1x13 pages (127 total). Recent rows are absent before their creation time.",
				"Brief calibration: issues 246s/180 requests; PRs 391s/360 REST+state requests; Actions stream 428s/127 requests.",
				"Actions snapshot 42.7s/13 requests; other snapshot request latency = (1071s - 127*42.7s/13)/480.",
				"Actions deployment-history requests use the same per-page latency as Actions snapshots but are reported separately.",
				"Other request latency is the existing L2 factory GraphQL fixture's 300ms; calibration is a synthetic workload, not a production replay.",
				"Zero D1/CPU/queue-delivery latency; no cancellation, overload or recovery stalls injected; nextAttemptAt waits are included.",
				"Concurrent fake requests overlap on a virtual event clock; native crypto must finish before advancing; 1ms host turns do not count as simulated latency.",
				"No production wall-time prediction or proof of the under-20-minute SLO; actual requests and invocation boundaries are executed.",
			],
			warmup,
			measured,
		};
	} finally {
		Date.now = originalNow;
		globalThis.fetch = originalFetch;
		if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
		process.chdir(originalDirectory);
	}
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			source: { type: "string" },
			label: { type: "string" },
			repos: { type: "string", default: "60" },
			cold: { type: "boolean", default: false },
			selection: { type: "string", default: "all" },
		},
	});
	if (values.selection !== "all" && values.selection !== "selected")
		throw new Error("selection must be all or selected");
	const originalLog = console.log;
	const originalInfo = console.info;
	console.log = console.error;
	console.info = console.error;
	try {
		const result = await runBenchmark({
			source: values.source ?? process.cwd(),
			label: values.label ?? "working-tree",
			repos: Number(values.repos),
			warm: !values.cold,
			selection: values.selection,
		});
		originalLog(JSON.stringify(result, null, 2));
	} finally {
		console.log = originalLog;
		console.info = originalInfo;
	}
}
