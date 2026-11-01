import { expect, it, vi } from "vitest";
import { annualContributionCalendar } from "../../../../../../tests/fixtures/contribution-calendar";
import golden from "../../../../../../tests/fixtures/refresh-publication-golden.json";
import { sqliteFixture } from "../../../../../../tests/fixtures/sqlite";
import * as warmRun from "../dashboard-warm-run";
import { createDb, type Db } from "../db/d1";
import { factoryRateStatement } from "../factory-rate";
import type { CollectionContext } from "../refresh-collection-contract";
import { parseRefreshParams, refreshDays } from "../refresh-params";
import { publicationRetentionStatement } from "../saved-observation-statements";
import { publish, shouldReplacePublishedFactorySnapshot } from "./store";

const now = "2026-10-29T06:00:00.000Z";

it("does not replace a complete published factory snapshot with a partial one", () => {
	expect(
		shouldReplacePublishedFactorySnapshot(
			{ status: "complete" } as never,
			{ status: "partial" } as never,
		),
	).toBe(false);
	expect(
		shouldReplacePublishedFactorySnapshot(
			{ status: "partial" } as never,
			{ status: "partial" } as never,
		),
	).toBe(true);
	expect(shouldReplacePublishedFactorySnapshot(null, { status: "partial" } as never)).toBe(true);
});

type Trip = { rpc: number; reads: number; writes: number };

function countTrips(raw: D1Database) {
	const originals = new WeakMap<
		D1PreparedStatement,
		{ statement: D1PreparedStatement; sql: string }
	>();
	const trips: Trip[] = [];
	const sqls: string[] = [];
	const isRead = (sql: string) => /^\s*(SELECT|WITH|EXPLAIN)\b/i.test(sql);
	const record = (entries: { sql: string }[]) =>
		trips.push({
			rpc: entries.length,
			reads: entries.filter((entry) => isRead(entry.sql)).length,
			writes: entries.filter((entry) => !isRead(entry.sql)).length,
		});
	const wrap = (sql: string, statement: D1PreparedStatement): D1PreparedStatement => {
		const wrapped = {
			bind: (...values: unknown[]) => wrap(sql, statement.bind(...values)),
			first: async () => {
				record([{ sql }]);
				return statement.first();
			},
			all: async () => {
				record([{ sql }]);
				return statement.all();
			},
			run: async () => {
				record([{ sql }]);
				return statement.run();
			},
		} as unknown as D1PreparedStatement;
		originals.set(wrapped, { statement, sql });
		return wrapped;
	};
	return {
		trips,
		sqls,
		raw: {
			prepare: (sql: string) => {
				sqls.push(sql);
				return wrap(sql, raw.prepare(sql));
			},
			batch: async (batch: D1PreparedStatement[]) => {
				const resolved = batch.map((statement) => {
					const entry = originals.get(statement);
					if (!entry) throw new Error("foreign statement");
					return entry;
				});
				record(resolved);
				return raw.batch(resolved.map((entry) => entry.statement));
			},
		} as unknown as D1Database,
	};
}

const coverage = (status: "complete" | "partial" | "unavailable", fetchedAt: string | null) => ({
	status,
	pages: status === "unavailable" ? 0 : 1,
	fetchedAt,
	source: "graphql",
	observed: status === "unavailable" ? 0 : 1,
});
const publication = (id: string, name: string, actions: "complete" | "partial") => ({
	id,
	name,
	url: `https://github.com/${name}`,
	coverage: {
		commits: coverage("complete", "2026-10-29T05:00:02.000Z"),
		issues: coverage("complete", "2026-10-29T05:00:02.000Z"),
		prs: coverage("complete", "2026-10-29T05:00:02.000Z"),
		actions: coverage(actions, actions === "complete" ? "2026-10-29T05:00:02.000Z" : null),
		releases: coverage("complete", "2026-10-29T05:00:02.000Z"),
		alerts: coverage("unavailable", null),
		dependencies: coverage("unavailable", null),
	},
	observation: { version: "run-b", window: {}, refreshedAt: "2026-10-29T05:00:02.000Z" },
});
const source = (kind: string, repoId: string, fetchedAt: string, payload: object) => ({
	kind,
	payload: JSON.stringify({ repo_id: repoId, fetched_at: fetchedAt, ...payload }),
	fetched_at: fetchedAt,
});
const issue = (id: string) => ({
	id,
	title: id,
	url: `https://github.com/owner/alpha/issues/${id}`,
	createdAt: "2026-10-29T01:00:00.000Z",
	closedAt: null,
	state: "open",
});
const catalog = [
	{ id: "R_1", name: "owner/alpha", active: 1, actions: "complete" as const },
	{ id: "R_2", name: "owner/beta", active: 1, actions: "partial" as const },
	{ id: "R_3", name: "owner/gamma", active: 1, actions: "complete" as const },
	{ id: "R_9", name: "owner/delta", active: 0, actions: "complete" as const },
];
const catalogOf = (count: number) =>
	Array.from({ length: count }, (_, index) => ({
		id: `R_${index}`,
		name: `owner/repository-${String(index).padStart(3, "0")}`,
		active: 1,
		actions: "complete" as const,
	}));
const account = (repositories: number) => {
	const { window, calendar } = annualContributionCalendar(now, 2);
	return {
		schema: 1,
		account_id: "a",
		owner: "owner",
		inventory: { total: repositories, scanned: repositories, complete: true },
		contributionStatus: "complete",
		contribution: {
			days: calendar.weeks
				.flatMap((week) => week.contributionDays)
				.map((day) => ({
					date: day.date,
					count: day.contributionCount,
					fetchedAt: now,
					observedAt: now,
					breakdown: "unavailable" as const,
				})),
			total: calendar.totalContributions,
			restricted: 0,
			fetchedAt: now,
			observedAt: now,
			timezone: "github",
			typesStatus: "partial",
		},
		contributionObservation: { version: "run-b", window, fetchedAt: now },
		repos: [],
	};
};
async function insert(raw: D1Database, sql: string, ...values: (string | number | null)[]) {
	return raw
		.prepare(sql)
		.bind(...values)
		.run();
}
async function prepared(
	raw: D1Database,
	rows: ReturnType<typeof source>[] = [],
	options: { catalog: typeof catalog; items?: number } = { catalog },
) {
	const params = parseRefreshParams(
		{ since: "2026-10-28", until: "2026-10-28", timezone: "Asia/Shanghai" },
		new Date(now),
	);
	const context = {
		env: { DB: raw, ENVIRONMENT: "test", GITHUB_API_BASE: "http://github.test" },
		account: { id: "a", login: "owner" },
		token: "memory-only-fake-token",
		run: { id: "run-b", accountId: "a", params, requests: 0, createdAt: now },
		days: refreshDays(params),
		now,
	} as unknown as CollectionContext;
	await insert(
		raw,
		"INSERT INTO accounts(id,login,avatar_url,token_ciphertext,token_last4,key_version,scopes,capabilities,is_active,created_at,updated_at) VALUES('a','owner','','encrypted','test',1,'','{}',1,?,?)",
		now,
		now,
	);
	await insert(
		raw,
		"INSERT INTO refresh_accounts(account_id,payload,fetched_at) VALUES('a',?,?)",
		JSON.stringify(account(options.catalog.length)),
		now,
	);
	for (const { id, name, active, actions } of options.catalog) {
		await insert(
			raw,
			"INSERT INTO refresh_catalog(account_id,repo_id,repo,discovered_day,timezone,payload,fetched_at,active) VALUES('a',?,?,'2026-10-29','Asia/Shanghai',?,?,?)",
			id,
			name,
			JSON.stringify({ id, nameWithOwner: name }),
			now,
			active,
		);
		if (id === "R_3") continue;
		await insert(
			raw,
			"INSERT INTO refresh_repository_publications(account_id,repo_id,payload,fetched_at) VALUES('a',?,?,?)",
			id,
			JSON.stringify(publication(id, name, actions)),
			now,
		);
	}
	const bulk = options.items
		? options.catalog.flatMap(({ id, name }) =>
				["issues", "prs", "security"].map((kind) =>
					source(`repo:${name}:${kind}`, id, "2026-10-29T05:00:02.000Z", {
						...(kind === "issues"
							? {
									issues: Array.from({ length: options.items ?? 0 }, (_, index) =>
										issue(`${id}_${index}`),
									),
								}
							: {}),
						...(kind === "prs"
							? {
									pull_requests: Array.from({ length: options.items ?? 0 }, (_, index) =>
										issue(`${id}_${index}`),
									),
								}
							: {}),
						...(kind === "security"
							? {
									items: [],
									dependabot_open: 0,
									code_scanning_open: null,
									unavailable: false,
								}
							: {}),
						truncated: false,
					}),
				),
			)
		: rows;
	for (const row of bulk)
		await insert(
			raw,
			"INSERT INTO refresh_snapshots(account_id,kind,payload,fetched_at,content_meta) VALUES('a',?,?,?,NULL)",
			row.kind,
			row.payload,
			row.fetched_at,
		);
	return context;
}
const fixtures = [
	source("repo:owner/alpha:issues", "R_1", "2026-10-29T05:00:02.000Z", {
		issues: [issue("I1"), issue("I2")],
		truncated: false,
	}),
	source("repo:Owner/Alpha:issues", "R_1", "2026-10-29T05:00:01.000Z", {
		issues: [issue("I0")],
		truncated: false,
	}),
	source("repo:owner/alpha:prs", "R_1", "2026-10-29T05:00:03.000Z", {
		pull_requests: [{ ...issue("P1"), mergedAt: null }],
		truncated: true,
	}),
	source("repo:owner/alpha:security", "R_1", "2026-10-29T05:00:04.000Z", {
		items: [
			{ ...issue("A1"), source: "dependabot" },
			{ ...issue("A2"), source: "code_scanning" },
		],
		dependabot_open: 1,
		code_scanning_open: 1,
		unavailable: false,
		truncated: false,
	}),
	source("repo:owner/beta:issues", "R_2", "2026-10-29T05:00:05.000Z", {
		issues: [issue("I3")],
		truncated: true,
	}),
	source("repo:owner/beta:prs", "R_2", "2026-10-29T05:00:06.000Z", {
		pull_requests: [],
		truncated: true,
		unavailable: true,
	}),
	source("repo:owner/beta:security", "R_2", "2026-10-29T05:00:06.000Z", {
		items: [],
		unavailable: true,
		truncated: true,
	}),
	source("repo:owner/delta:issues", "R_9", "2026-10-29T05:00:07.000Z", {
		issues: [issue("I9")],
		truncated: false,
	}),
];
function summarized(payload: string) {
	const data = JSON.parse(payload) as {
		contribution?: { days: { date: string }[]; total: number };
	};
	const contribution = data.contribution;
	if (!contribution) return data;
	const days = contribution.days ?? [];
	return {
		...data,
		contribution: {
			...contribution,
			days: { count: days.length, first: days[0]?.date, last: days.at(-1)?.date },
		},
	};
}
function goldenShape(rows: Awaited<ReturnType<typeof publishedRows>>) {
	return {
		snapshots: rows.snapshots.map((row) =>
			row.kind === "factory" ? { ...row, payload: JSON.stringify(summarized(row.payload)) } : row,
		),
		publication: rows.publication
			? {
					...rows.publication,
					payload: JSON.stringify(summarized(rows.publication.payload)),
				}
			: rows.publication,
	};
}
async function publishedRows(raw: D1Database) {
	const snapshots = await raw
		.prepare(
			"SELECT kind,payload,fetched_at,content_meta FROM refresh_snapshots WHERE account_id='a' AND kind IN ('issues','prs','alerts','factory') ORDER BY kind",
		)
		.all<{ kind: string; payload: string; fetched_at: string; content_meta: string }>();
	const accountPublication = await raw
		.prepare("SELECT payload,published_at FROM refresh_publications WHERE account_id='a'")
		.first<{ payload: string; published_at: string }>();
	return { snapshots: snapshots.results, publication: accountPublication };
}

it("publishes aggregates in batched reads and writes without changing output", async () => {
	const raw = sqliteFixture();
	const counted = countTrips(raw);
	const context = await prepared(raw, fixtures);
	await publish(createDb(counted.raw), context);
	expect(counted.trips).toEqual([
		{ rpc: 1, reads: 1, writes: 0 },
		{ rpc: 3, reads: 3, writes: 0 },
		{ rpc: 9, reads: 0, writes: 9 },
	]);
	expect(counted.sqls.filter((sql) => sql.includes("refresh_catalog"))).toHaveLength(2);
	expect(counted.sqls.some((sql) => /SELECT \* FROM refresh_catalog/i.test(sql))).toBe(false);
	expect(goldenShape(await publishedRows(raw))).toEqual(golden);
});

it("republishes identical rows without extra round trips", async () => {
	const raw = sqliteFixture();
	const counted = countTrips(raw);
	const context = await prepared(raw, fixtures);
	await publish(createDb(counted.raw), context);
	const first = goldenShape(await publishedRows(raw));
	await publish(createDb(counted.raw), context);
	expect(counted.trips).toHaveLength(6);
	expect(goldenShape(await publishedRows(raw))).toEqual(first);
});

it("skips factory snapshot aggregation when updateFactorySnapshot is false", async () => {
	const raw = sqliteFixture();
	const context = await prepared(raw, fixtures);
	const db = createDb(raw);
	await publish(db, context);
	const before = goldenShape(await publishedRows(raw));
	await publish(
		db,
		context,
		[
			db
				.prepare(
					"UPDATE refresh_accounts SET payload=json_set(payload,'$.runId',?) WHERE account_id='a'",
				)
				.bind("run-account-only"),
		],
		{ updateFactorySnapshot: false },
	);
	expect(goldenShape(await publishedRows(raw))).toEqual(before);
	const account = JSON.parse(
		(
			await raw
				.prepare("SELECT payload FROM refresh_accounts WHERE account_id='a'")
				.first<{ payload: string }>()
		)?.payload ?? "{}",
	) as { runId: string };
	expect(account.runId).toBe("run-account-only");
});

it("keeps complete published snapshots when a partial observation would regress them", async () => {
	const raw = sqliteFixture();
	const context = await prepared(raw, fixtures);
	const db = createDb(raw);
	await publish(db, context);
	await raw
		.prepare(
			"UPDATE refresh_snapshots SET payload=json_set(payload,'$.status',?) WHERE account_id='a' AND kind='factory'",
		)
		.bind("complete")
		.run();
	const before = goldenShape(await publishedRows(raw));
	await publish(db, context, [
		db.prepare(
			"UPDATE refresh_accounts SET payload=json_set(payload,'$.status','partial','$.inventory.complete',json('false')) WHERE account_id='a'",
		),
	]);
	expect(goldenShape(await publishedRows(raw))).toEqual(before);
	const account = JSON.parse(
		(
			await raw
				.prepare("SELECT payload FROM refresh_accounts WHERE account_id='a'")
				.first<{ payload: string }>()
		)?.payload ?? "{}",
	) as { status: string };
	expect(account.status).toBe("partial");
});

it("retains contribution calendar from the prior factory snapshot when account observation lacks it", async () => {
	const raw = sqliteFixture();
	const context = await prepared(raw, fixtures);
	const db = createDb(raw);
	await publish(db, context);
	const calendar = {
		days: [
			{
				date: "2026-10-28",
				count: 4,
				fetchedAt: now,
				observedAt: now,
				breakdown: "unavailable" as const,
			},
		],
		total: 4,
		restricted: 0,
		fetchedAt: now,
		observedAt: now,
		timezone: "github" as const,
		typesStatus: "partial" as const,
	};
	await raw
		.prepare(
			"UPDATE refresh_snapshots SET payload=json_set(payload,'$.contribution',json(?),'$.contributionStatus','complete') WHERE account_id='a' AND kind='factory'",
		)
		.bind(JSON.stringify(calendar))
		.run();
	await publish(db, context, [
		db.prepare(
			"UPDATE refresh_accounts SET payload=json_set(payload,'$.contribution',json('null'),'$.contributionStatus','unavailable') WHERE account_id='a'",
		),
	]);
	const factory = JSON.parse(
		(
			await raw
				.prepare("SELECT payload FROM refresh_snapshots WHERE account_id='a' AND kind='factory'")
				.first<{ payload: string }>()
		)?.payload ?? "{}",
	) as { contribution: { total: number } | null };
	expect(factory.contribution?.total).toBe(4);
});

it("keeps rate and identity-fenced retention in a compact operational publication", async () => {
	const raw = sqliteFixture();
	const context = await prepared(raw, fixtures);
	const rate = {
		remaining: 100,
		resetAt: "2026-10-29T07:00:00Z",
		observedAt: now,
		resource: "graphql",
	};
	await raw
		.prepare("UPDATE refresh_accounts SET payload=json_set(payload,'$.rate',json(?))")
		.bind(JSON.stringify(rate))
		.run();
	await raw
		.prepare(
			"UPDATE refresh_repository_publications SET payload=json_set(payload,'$.coverage.dependencies.retained',json('true')) WHERE repo_id='R_1'",
		)
		.run();
	const db = createDb(raw);
	await publish(db, context);
	const rows = await publishedRows(raw);
	const operational = JSON.parse(rows.publication?.payload ?? "{}");
	expect(Object.keys(operational)).toEqual(["rate", "repos"]);
	expect(operational.rate).toEqual(rate);
	expect(operational.repos.map((repo: { name: string }) => repo.name)).toEqual([
		"owner/alpha",
		"owner/beta",
	]);
	expect(Object.keys(operational.repos[0].coverage)).toHaveLength(7);
	expect(operational.repos[0].coverage.dependencies).toEqual({ retained: true });
	expect(operational.repos[1].coverage.dependencies).toEqual({ retained: false });
	const compactRate = await factoryRateStatement(db, "a").first();
	const compactRetention = await publicationRetentionStatement(
		db,
		"a",
		["owner/beta"],
		["R_1"],
	).all<{ payload: string }>();
	expect(compactRetention.results.map((row) => JSON.parse(row.payload).id)).toEqual(["R_1", "R_2"]);
	await raw
		.prepare("UPDATE refresh_publications SET payload=? WHERE account_id='a'")
		.bind(rows.snapshots.find((row) => row.kind === "factory")?.payload)
		.run();
	expect(await factoryRateStatement(db, "a").first()).toEqual(compactRate);
	expect(await publicationRetentionStatement(db, "a", ["owner/beta"], ["R_1"]).all()).toEqual(
		compactRetention,
	);
});

it("marks mixed publications when a repository was refreshed by another run", async () => {
	const raw = sqliteFixture();
	const context = await prepared(raw, fixtures);
	await raw
		.prepare(
			"UPDATE refresh_repository_publications SET payload=? WHERE account_id='a' AND repo_id='R_2'",
		)
		.bind(
			JSON.stringify({
				...publication("R_2", "owner/beta", "partial"),
				observation: { version: "run-a" },
			}),
		)
		.run();
	await publish(createDb(raw), context);
	const rows = await publishedRows(raw);
	const factory = JSON.parse(
		rows.snapshots.find((row) => row.kind === "factory")?.payload ?? "{}",
	) as {
		publication: { mixed: boolean };
		repos: { name: string }[];
	};
	expect(factory.publication.mixed).toBe(true);
	expect(factory.repos.map((repo) => repo.name)).toEqual(["owner/alpha", "owner/beta"]);
});

it("sees pending observation writes in the same publication batch", async () => {
	const raw = sqliteFixture();
	const counted = countTrips(raw);
	const context = await prepared(raw, fixtures);
	const db = createDb(counted.raw);
	await publish(db, context, [
		db
			.prepare(
				"INSERT INTO refresh_repository_publications(account_id,repo_id,payload,fetched_at) VALUES('a','R_3',?,?) ON CONFLICT(account_id,repo_id) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at",
			)
			.bind(JSON.stringify(publication("R_3", "owner/gamma", "complete")), now),
		db
			.prepare(
				"INSERT INTO refresh_snapshots(account_id,kind,payload,fetched_at,content_meta) VALUES('a','repo:owner/gamma:issues',?,'2026-10-29T05:00:09.000Z',NULL)",
			)
			.bind(
				JSON.stringify({
					repo_id: "R_3",
					fetched_at: "2026-10-29T05:00:09.000Z",
					issues: [issue("I4")],
					truncated: false,
				}),
			),
	]);
	expect(counted.trips).toEqual([
		{ rpc: 1, reads: 1, writes: 0 },
		{ rpc: 5, reads: 3, writes: 2 },
		{ rpc: 9, reads: 0, writes: 9 },
	]);
	const rows = await publishedRows(raw);
	const factory = JSON.parse(rows.publication?.payload ?? "{}") as { repos: { name: string }[] };
	expect(factory.repos.map((repo) => repo.name)).toEqual([
		"owner/alpha",
		"owner/beta",
		"owner/gamma",
	]);
	const issues = JSON.parse(
		rows.snapshots.find((row) => row.kind === "issues")?.payload ?? "{}",
	) as {
		issues: { id: string }[];
		repository_fetched_at: Record<string, string | null>;
		fetched_at: string;
	};
	expect(issues.repository_fetched_at["owner/gamma"]).toBe("2026-10-29T05:00:09.000Z");
	expect(issues.issues.map((item) => item.id)).toEqual(["I1", "I2", "I3", "I4"]);
	expect(issues.fetched_at).toBe("2026-10-29T05:00:09.000Z");
});

it("rolls back pending observation writes when a snapshot read fails in the batch", async () => {
	const raw = sqliteFixture();
	const counted = countTrips(raw);
	const context = await prepared(raw, fixtures);
	const db = createDb(counted.raw);
	const pending = [
		db
			.prepare(
				"INSERT INTO refresh_day_observations(account_id,repo_id,timezone,day,dimension,status,payload,fetched_at) VALUES('a','R_1','Asia/Shanghai','2026-10-28','commits','complete','{}',?)",
			)
			.bind(now),
	];
	await raw.prepare("DROP TABLE refresh_catalog").run();
	await expect(publish(db, context, pending)).rejects.toMatchObject({ code: "db_error" });
	expect(counted.trips).toEqual([
		{ rpc: 1, reads: 1, writes: 0 },
		{ rpc: 4, reads: 3, writes: 1 },
	]);
	const days = await raw
		.prepare("SELECT COUNT(*) AS n FROM refresh_day_observations")
		.first<{ n: number }>();
	expect(days?.n).toBe(0);
	const publications = await raw
		.prepare("SELECT COUNT(*) AS n FROM refresh_publications")
		.first<{ n: number }>();
	expect(publications?.n).toBe(0);
});

const observationWrites = (db: Db, index: number) => {
	const id = `R_${index}`;
	const name = `owner/repository-${String(index).padStart(3, "0")}`;
	const at = "2026-10-29T05:00:02.000Z";
	return [
		db
			.prepare(
				"INSERT INTO refresh_repository_publications(account_id,repo_id,payload,fetched_at) VALUES('a',?,?,?) ON CONFLICT(account_id,repo_id) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at",
			)
			.bind(id, JSON.stringify(publication(id, name, "complete")), now),
		db
			.prepare(
				"INSERT INTO refresh_day_observations(account_id,repo_id,timezone,day,dimension,status,payload,fetched_at) VALUES('a',?,'Asia/Shanghai','2026-10-28','commits','complete','{}',?) ON CONFLICT(account_id,repo_id,timezone,day,dimension) DO UPDATE SET status=excluded.status,payload=excluded.payload,fetched_at=excluded.fetched_at",
			)
			.bind(id, now),
		db
			.prepare("DELETE FROM refresh_snapshots WHERE account_id='a' AND kind IN (?,?)")
			.bind(`repo:${name}:issues`, `repo:${name}:issues#2`),
		db
			.prepare(
				"INSERT INTO refresh_snapshots(account_id,kind,payload,fetched_at,content_meta) VALUES('a',?,?,?,NULL)",
			)
			.bind(
				`repo:${name}:issues`,
				JSON.stringify({
					repo_id: id,
					fetched_at: at,
					issues: Array.from({ length: 25 }, (_, item) => issue(`${id}_${item}`)),
					truncated: false,
				}),
				at,
			),
	];
};

it("publishes a full catalogue with two round trips per step", async () => {
	const raw = sqliteFixture();
	const counted = countTrips(raw);
	const context = await prepared(raw, [], { catalog: catalogOf(61), items: 25 });
	const stats = { digests: 0, digestMs: 0, digestBytes: 0 };
	const digest = crypto.subtle.digest.bind(crypto.subtle);
	crypto.subtle.digest = ((...args: Parameters<typeof digest>) => {
		stats.digests += 1;
		const data = args[1];
		stats.digestBytes +=
			data instanceof ArrayBuffer ? data.byteLength : (data as Uint8Array).byteLength;
		const started = performance.now();
		return digest(...args).finally(() => {
			stats.digestMs += performance.now() - started;
		});
	}) as typeof crypto.subtle.digest;
	const started = performance.now();
	try {
		for (let index = 0; index < 61; index += 1) await publish(createDb(counted.raw), context);
	} finally {
		crypto.subtle.digest = digest;
	}
	const elapsedMs = performance.now() - started;
	const bytes = await raw
		.prepare(
			"SELECT SUM(length(CAST(payload AS BLOB))) AS bytes FROM refresh_snapshots WHERE kind IN ('issues','prs','alerts','factory')",
		)
		.first<{ bytes: number }>();
	console.log(
		`publish-profile ${JSON.stringify({
			repositories: 61,
			publishes: 61,
			rpcs: counted.trips.length,
			rpcsPerPublish: counted.trips.length / 61,
			statements: counted.trips.reduce((sum, trip) => sum + trip.rpc, 0),
			readStatements: counted.trips.reduce((sum, trip) => sum + trip.reads, 0),
			writeStatements: counted.trips.reduce((sum, trip) => sum + trip.writes, 0),
			elapsedMs: Math.round(elapsedMs * 10) / 10,
			perPublishMs: Math.round((elapsedMs / 61) * 100) / 100,
			publishedBytes: bytes?.bytes,
			digests: stats.digests,
			digestMs: Math.round(stats.digestMs),
			digestMB: Math.round(stats.digestBytes / 1_000_000),
		})}`,
	);
	expect(counted.trips).toHaveLength(183);
	expect(counted.trips.map((trip) => trip.rpc)).toEqual(
		Array.from({ length: 61 }, () => [1, 3, 9]).flat(),
	);
});
it("publishes each observation step with two round trips end to end", async () => {
	const raw = sqliteFixture();
	const counted = countTrips(raw);
	const context = await prepared(raw, [], { catalog: catalogOf(61), items: 25 });
	const started = performance.now();
	for (let index = 0; index < 61; index += 1) {
		const db = createDb(counted.raw);
		await publish(db, context, observationWrites(db, index));
	}
	const elapsedMs = performance.now() - started;
	console.log(
		`step-profile ${JSON.stringify({
			repositories: 61,
			steps: 61,
			rpcs: counted.trips.length,
			rpcsPerStep: counted.trips.length / 61,
			statements: counted.trips.reduce((sum, trip) => sum + trip.rpc, 0),
			statementsPerStep: counted.trips.reduce((sum, trip) => sum + trip.rpc, 0) / 61,
			readStatements: counted.trips.reduce((sum, trip) => sum + trip.reads, 0),
			writeStatements: counted.trips.reduce((sum, trip) => sum + trip.writes, 0),
			elapsedMs: Math.round(elapsedMs * 10) / 10,
			perStepMs: Math.round((elapsedMs / 61) * 100) / 100,
		})}`,
	);
	expect(counted.trips).toHaveLength(183);
	expect(counted.trips).toEqual(
		Array.from({ length: 61 }, () => [
			{ rpc: 1, reads: 1, writes: 0 },
			{ rpc: 7, reads: 3, writes: 4 },
			{ rpc: 9, reads: 0, writes: 9 },
		]).flat(),
	);
});

it("completes publish when dashboard warm fails safely", async () => {
	const raw = sqliteFixture();
	const base = await prepared(raw, fixtures);
	const context = {
		...base,
		env: { ...base.env, ENVIRONMENT: "production" },
	} as typeof base;
	const warmSpy = vi
		.spyOn(warmRun, "warmDashboardResponsesAfterPublish")
		.mockRejectedValue(new Error("warm failed"));
	const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		await publish(createDb(raw), context);
		expect(goldenShape(await publishedRows(raw))).toEqual(golden);
		expect(warmSpy.mock.calls.length).toBeGreaterThan(0);
		expect(
			warnSpy.mock.calls.some(([message]) =>
				String(message).includes("dashboard warm after publish failed"),
			),
		).toBe(true);
	} finally {
		warmSpy.mockRestore();
		warnSpy.mockRestore();
	}
});

it("writes dashboard warm rows after publish outside test environment", async () => {
	const raw = sqliteFixture();
	const base = await prepared(raw, fixtures);
	const context = {
		...base,
		env: { ...base.env, ENVIRONMENT: "production" },
	} as typeof base;
	await publish(createDb(raw), context);
	const rows = await raw
		.prepare("SELECT COUNT(*) AS count FROM dashboard_warm_responses WHERE account_id='a'")
		.first<{ count: number }>();
	expect(rows?.count ?? 0).toBeGreaterThan(0);
});
