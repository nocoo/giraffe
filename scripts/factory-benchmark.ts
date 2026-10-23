import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types/index.ts";
import type { FactoryRun, FactoryRunStep } from "../apps/web/src/lib/factory-run";
import type { FactoryRepo } from "../apps/web/src/lib/factory-types";
import { factoryFixture } from "../tests/fixtures/factory-snapshot";
import { factoryGraphqlStub, factoryRepoStub } from "./factory-stub";

const START = Date.parse("2026-10-23T04:00:00+08:00");
const DAY = 86_400_000;
const ORIGIN = "https://factory-benchmark.invalid";
const KEY = "0".repeat(64);
const ACCOUNT = "benchmark-account";
const DISPATCH_MS = 2300;

type Phase = "account" | "factory" | "snapshot" | "activity" | "insights" | "publish";
type Interval = { phase: Phase; repo: string | null; start: number; end: number };

function stepPhase(step: FactoryRunStep): Phase {
	if (step.kind === "publish") return "publish";
	if (step.resource === "insights") return "insights";
	if (step.kind === "activity") return "activity";
	if (!step.repo) return "account";
	return step.kind === "snapshot" ? "snapshot" : "factory";
}

export function benchmarkPhases(intervals: Interval[], started: number, finished: number) {
	const phases = [...new Set(intervals.map((entry) => entry.phase))];
	return phases
		.map((phase) => {
			const own = intervals.filter((entry) => entry.phase === phase);
			const start = Math.min(...own.map((entry) => entry.start));
			const end = Math.max(...own.map((entry) => entry.end));
			const points = [
				...new Set([start, end, ...own.flatMap((entry) => [entry.start, entry.end])]),
			].sort((left, right) => left - right);
			const laneMs = [0, 0, 0, 0, 0];
			for (let index = 0; index < points.length - 1; index++) {
				const left = points[index] as number;
				const right = points[index + 1] as number;
				const busy = new Set(
					own
						.filter((entry) => entry.start <= left && entry.end > left)
						.map((entry) => entry.repo ?? "account"),
				).size;
				if (busy > 4) throw new Error("Benchmark observed more than four busy lanes");
				laneMs[busy] = (laneMs[busy] ?? 0) + right - left;
			}
			const wallMs = end - start;
			return {
				phase,
				wallMs,
				exclusiveWallMs: 0,
				laneMs,
				lanePercent: laneMs.map((value) => (wallMs ? (value / wallMs) * 100 : 0)),
				averageBusyLanes: wallMs
					? laneMs.reduce((sum, value, lanes) => sum + value * lanes, 0) / wallMs
					: 0,
				requests: 0,
				serviceMs: 0,
				start,
				end,
			};
		})
		.map((phase, index, all) => {
			const boundaries = [
				...new Set([started, finished, ...all.flatMap((entry) => [entry.start, entry.end])]),
			].sort((left, right) => left - right);
			for (let point = 0; point < boundaries.length - 1; point++) {
				const left = boundaries[point] as number;
				const right = boundaries[point + 1] as number;
				const active = all.filter((entry) => entry.start <= left && entry.end > left);
				const prior = all.filter((entry) => entry.start <= left).at(-1) ?? all[0];
				if (active.length ? active.includes(phase) : prior === all[index])
					phase.exclusiveWallMs += (right - left) / Math.max(1, active.length);
			}
			return phase;
		});
}

function benchmarkJournal(raw: D1Database, clock: BenchmarkClock) {
	let run: FactoryRun | null = null;
	const active = new Map<number, { step: FactoryRunStep; start: number }>();
	let intervals: Interval[] = [];
	let requests: { phase: Phase; serviceMs: number }[] = [];
	const statements = new WeakMap<
		D1PreparedStatement,
		{ original: D1PreparedStatement; observe: () => void }
	>();
	function observe(query: string, values: unknown[]) {
		if (query.startsWith("UPDATE factory_run_journal SET journal=json_patch")) {
			const audits = JSON.parse(String(values[0])) as Record<string, unknown>;
			for (const key of Object.keys(audits)) {
				const index = Number(key);
				const step = run?.steps[index];
				if (step && !active.has(index)) active.set(index, { step, start: clock.now });
			}
		} else if (query.startsWith("UPDATE factory_runs SET payload=?")) {
			run = JSON.parse(String(values[0])) as FactoryRun;
		} else if (query.startsWith("UPDATE factory_run_journal SET journal=?")) {
			const audits = JSON.parse(String(values[0])) as Record<string, unknown>;
			for (const [index, entry] of active) {
				if (String(index) in audits) continue;
				intervals.push({
					phase: stepPhase(entry.step),
					repo: entry.step.repo,
					start: entry.start,
					end: clock.now,
				});
				active.delete(index);
			}
		}
	}
	function wrap(
		original: D1PreparedStatement,
		query: string,
		values: unknown[] = [],
	): D1PreparedStatement {
		const statement = {
			bind: (...bound: unknown[]) => wrap(original.bind(...bound), query, bound),
			first: original.first.bind(original),
			all: original.all.bind(original),
			run: async () => {
				const result = await original.run();
				if (result.meta.changes) observe(query, values);
				return result;
			},
		} as D1PreparedStatement;
		statements.set(statement, { original, observe: () => observe(query, values) });
		return statement;
	}
	return {
		db: {
			prepare: (query: string) => wrap(raw.prepare(query), query),
			batch: async (batch: D1PreparedStatement[]) => {
				const result = await raw.batch(
					batch.map((statement) => statements.get(statement)?.original ?? statement),
				);
				batch.forEach((statement, index) => {
					if (result[index]?.meta.changes) statements.get(statement)?.observe();
				});
				return result;
			},
		} as D1Database,
		request: (serviceMs: number, repo: string | null) => {
			const entries = [...active.values()];
			const step = (entries.find((entry) => entry.step.repo === repo) ?? entries[0])?.step;
			if (!step) throw new Error("Benchmark request has no journaled step");
			requests.push({ phase: stepPhase(step), serviceMs });
		},
		reset: (initial: FactoryRun) => {
			run = initial;
			active.clear();
			intervals = [];
			requests = [];
		},
		report: (started: number, finished: number) => {
			const pool = intervals
				.filter((entry) => entry.repo)
				.map((entry) => ({ ...entry, phase: "factory" as const }));
			const occupancy = pool.length
				? benchmarkPhases(
						pool,
						Math.min(...pool.map((entry) => entry.start)),
						Math.max(...pool.map((entry) => entry.end)),
					)[0]
				: null;
			return {
				poolOccupancy: occupancy
					? {
							wallMs: occupancy.wallMs,
							laneMs: occupancy.laneMs,
							lanePercent: occupancy.lanePercent,
							averageBusyLanes: occupancy.averageBusyLanes,
						}
					: null,
				phases: benchmarkPhases(intervals, started, finished).map((phase) => ({
					...phase,
					requests: requests.filter((request) => request.phase === phase.phase).length,
					serviceMs: requests
						.filter((request) => request.phase === phase.phase)
						.reduce((sum, request) => sum + request.serviceMs, 0),
				})),
			};
		},
	};
}

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
			this.schedule();
		});
	}

	sleep(milliseconds: number) {
		return new Promise<void>((finish) => {
			this.pending.push({ at: this.now + milliseconds, finish });
			this.schedule();
		});
	}

	private schedule() {
		if (this.timer || this.external || !this.pending.length) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.external) return;
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
	| "activity"
	| "notifications"
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
		activity: 299_000 / 205,
		notifications: 18_000 / 9,
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

export function benchmarkGithub(
	clock: BenchmarkClock,
	count: number,
	observe?: (serviceMs: number, repo: string | null) => void,
) {
	const repos = Array.from({ length: count }, (_, index) => repository(index));
	let metrics: Partial<Record<Category, RequestMetric>> = {};
	let concurrentRequests = 0;
	let maxConcurrentRequests = 0;
	let requestWallMs = 0;
	let requestStartedAt = clock.now;
	const unsupported: string[] = [];
	function response(category: Category, body: unknown, next: URL | undefined, repo: string | null) {
		const serviceMs = benchmarkLatency(category);
		observe?.(serviceMs, repo);
		metrics[category] ??= { requests: 0, serviceMs: 0 };
		const metric = metrics[category];
		metric.requests++;
		metric.serviceMs += serviceMs;
		if (concurrentRequests++ === 0) requestStartedAt = clock.now;
		maxConcurrentRequests = Math.max(maxConcurrentRequests, concurrentRequests);
		return clock
			.sleep(serviceMs)
			.then(() =>
				Response.json(body, {
					headers: next ? { link: `<${next.href}>; rel="next"` } : {},
				}),
			)
			.finally(() => {
				if (--concurrentRequests === 0) requestWallMs += clock.now - requestStartedAt;
			});
	}

	const fetch = async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== ORIGIN) {
			unsupported.push(`origin:${url.origin}`);
			throw new Error("Benchmark refuses non-fixture network destinations");
		}
		const variables =
			url.pathname === "/graphql"
				? (JSON.parse(String(init?.body)) as { variables?: Record<string, unknown> }).variables
				: undefined;
		const name = variables?.name ?? variables?.n;
		const restRepo = /^\/repos\/(octocat\/bench-\d+)/.exec(url.pathname)?.[1];
		const searchRepos =
			typeof variables?.q === "string"
				? [...variables.q.matchAll(/repo:(octocat\/bench-\d+)/g)]
				: [];
		const requestRepo =
			restRepo ??
			(name ? `octocat/${String(name)}` : searchRepos.length === 1 ? searchRepos[0]?.[1] : null) ??
			null;
		const respond = (category: Category, body: unknown, next?: URL) =>
			response(category, body, next, requestRepo);
		if (url.pathname === "/graphql") {
			const { query, variables = {} } = JSON.parse(String(init?.body)) as {
				query: string;
				variables?: Record<string, unknown>;
			};
			if (/query Activity(Refs|Tags|BranchHistory)/.test(query)) {
				const repo = repos.find((item) => item.name === variables.name);
				if (!repo) throw new Error("Unknown benchmark activity repository");
				const index = repos.indexOf(repo);
				const commit = (suffix: string) => ({
					oid: `activity-${index}-${suffix}`,
					committedDate: new Date(START - 3600_000).toISOString(),
					message: "Synthetic feature commit",
					url: `${repo.url}/commit/activity-${index}-${suffix}`,
					author: { user: { login: "octocat" } },
				});
				const connection = (nodes: unknown[], next: string | null = null) => ({
					nodes,
					pageInfo: { hasNextPage: next !== null, endCursor: next },
				});
				const tags = connection(
					[
						{
							name: "v1.0.0",
							target: {
								__typename: "Tag",
								oid: `tag-${index}`,
								tagger: { date: new Date(START - 3600_000).toISOString() },
							},
						},
					],
					query.includes("ActivityRefs") ? "tags-1" : null,
				);
				const body = query.includes("ActivityTags")
					? { tags }
					: query.includes("ActivityBranchHistory")
						? { object: { history: connection([commit("second")]) } }
						: {
								refs: connection(
									variables.after
										? [{ name: "main", target: { oid: "abc" } }]
										: [
												{
													name: "feature",
													target: {
														oid: `feature-${index}`,
														history: connection([commit("first")], "history-1"),
													},
												},
											],
									index % 60 < 25 && !variables.after ? "refs-1" : null,
								),
								tags,
							};
				return respond("activity", { data: { repository: body } });
			}
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
		if (url.pathname === "/notifications") {
			const page = Number(url.searchParams.get("page") ?? 1);
			const next =
				page < 9 ? new URL(url.pathname + url.search, "https://api.github.com") : undefined;
			next?.searchParams.set("page", String(page + 1));
			return respond(
				"notifications",
				Array.from({ length: 100 }, (_, index) => ({
					id: String((page - 1) * 100 + index),
					unread: true,
					reason: "subscribed",
					updated_at: new Date(START - 3600_000).toISOString(),
					subject: {
						title: "Synthetic notification",
						url: `https://api.github.com/repos/octocat/bench-000/issues/${index + 1}`,
					},
					repository: { full_name: "octocat/bench-000" },
				})),
				next,
			);
		}
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
		if (suffix === "/dependabot/alerts") return respond("other", []);
		const commits = [
			{
				sha: "abc",
				html_url: `${repo.url}/commit/abc`,
				commit: {
					message: "Synthetic default-branch commit",
					committer: { date: new Date(START - 7 * DAY).toISOString() },
					author: { date: new Date(START - 7 * DAY).toISOString() },
				},
				author: { login: "octocat" },
				parents: [],
			},
		];
		if (suffix === "/commits") {
			const since = url.searchParams.get("since");
			const until = url.searchParams.get("until");
			return respond(
				"other",
				commits.filter(
					(commit) =>
						(!since || commit.commit.committer.date >= since) &&
						(!until || commit.commit.committer.date <= until),
				),
			);
		}
		if (suffix?.startsWith("/compare/")) {
			const [base, head] = suffix.slice("/compare/".length).split("...");
			return respond("other", {
				status: base === head ? "identical" : "ahead",
				total_commits: base === head ? 0 : commits.length,
				ahead_by: base === head ? 0 : commits.length,
				behind_by: 0,
				commits: base === head ? [] : commits,
				base_commit: commits[0],
				merge_base_commit: commits[0],
			});
		}
		if (suffix === "/contributors" || suffix === "/releases")
			return respond(url.searchParams.has("page") ? "other" : "snapshot", []);
		if (["/issues", "/pulls", "/actions/runs"].includes(String(suffix))) {
			const actions = suffix === "/actions/runs";
			const pages = actions ? actionPages(index) : 3;
			const since = url.searchParams.get("since");
			const rows = Array.from({ length: pages }, (_, offset) => {
				const age = offset === 0 ? 2 / 24 : actions && offset >= 2 ? offset + 43 : offset + 2;
				const at = new Date(START - age * DAY).toISOString();
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
					...(actions ? { run_started_at: at } : {}),
					updated_at: at,
					closed_at: at,
					user: { login: "octocat" },
				};
			}).filter((row) => row.created_at <= clock.iso() && (!since || row.updated_at >= since));
			const created = url.searchParams.get("created");
			const range = created?.split("..");
			const filtered = rows.filter(
				(row) =>
					!range ||
					(created?.startsWith(">=")
						? row.created_at >= created.slice(2)
						: row.created_at >= String(range[0]) && row.created_at <= String(range[1])),
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
		timing: () => ({
			requestWallMs,
			serialServiceMs: Object.values(metrics).reduce((sum, metric) => sum + metric.serviceMs, 0),
			maxConcurrentRequests,
		}),
		reset: () => {
			metrics = {};
			maxConcurrentRequests = 0;
			requestWallMs = 0;
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
	let journal: ReturnType<typeof benchmarkJournal> | undefined;
	const github = benchmarkGithub(clock, count, (serviceMs, repo) =>
		journal?.request(serviceMs, repo),
	);
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
		const activeJournal = benchmarkJournal(sqliteFixture(), clock);
		journal = activeJournal;
		const raw = activeJournal.db;
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
			activeJournal.reset(run);
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
				const wait = Math.max(DISPATCH_MS, Date.parse(next) - clock.now);
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
				serialServiceMs: Math.round(github.timing().serialServiceMs),
				requestWallMs: Math.round(github.timing().requestWallMs),
				maxConcurrentRequests: github.timing().maxConcurrentRequests,
				...activeJournal.report(started, clock.now),
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
			profile: "b16a-60-repo-v2",
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
				"Actions rows: newest at -2h, next at -3d, all remaining pages at -45d or older; >= and inclusive range filters are honored. This exercises incremental retention outside the thirty-day rerun lookback; it is not the production age distribution.",
				"Brief calibration: issues 246s/180 requests; PRs 391s/360 REST+state requests; Actions stream 428s/127 requests.",
				"Actions snapshot 42.7s/13 requests; other snapshot request latency = (1071s - 127*42.7s/13)/480.",
				"Actions deployment-history requests use the same per-page latency as Actions snapshots but are reported separately.",
				"Account prelude uses the actual account collectors, including 9x100 notification rows at 2s per page (18s service); other existing request calibration is unchanged.",
				"Activity supplements per 60 repos: 60 first refs, 25 extra refs, 60 tag pages and 60 branch-history pages (205 total), calibrated to 299s service; default-branch commits and compare are fixture-only.",
				"Other request latency is the existing L2 factory GraphQL fixture's 300ms; calibration is a synthetic workload, not a production replay.",
				"Zero D1/CPU latency; each continuation adds at least 2.3s synthetic queue delivery, using the brief's median inter-step gap as a declared assumption, not a measured queue distribution. nextAttemptAt backoff is honored if longer. No startup lease-loss stall is injected.",
				"Phase wall spans include invocation gaps; lane occupancy comes from successful journal begin/accept writes, excluding idle gaps. Concurrent phase spans may overlap; exclusive wall time shares overlap equally and assigns gaps to the preceding phase.",
				"Concurrent fake requests overlap on a virtual event clock; native crypto must finish before advancing; 1ms host turns do not count as simulated latency.",
				"simulatedWallMs includes queue waits; requestWallMs is the union of in-flight request intervals; serialServiceMs sums request latencies and does not represent elapsed wall time.",
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
