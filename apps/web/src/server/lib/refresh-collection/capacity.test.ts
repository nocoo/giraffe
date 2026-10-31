import { afterEach, expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../../tests/fixtures/sqlite";
import type { FactorySnapshot, FactoryStreamData } from "../../../lib/factory-types";
import type { RefreshParams } from "../../../lib/refresh-types";
import type { Env } from "../../env";
import { createApp } from "../../index";
import { readActivity } from "../activity-store";
import { createDb } from "../db/d1";
import { readFactoryResource } from "../machine-observations";
import { readSources } from "../machine-sources";
import type { CollectionContext } from "../refresh-collection-contract";
import { refreshDays } from "../refresh-params";
import { assemblePages, type SnapshotPage } from "../snapshot-pages";
import { collectRepository } from "./index";
import { blankDay, blankMetrics } from "./model";
import { dayStatements, publish, resourceStatement, snapshots } from "./store";

const now = "2026-10-29T06:00:00.000Z";
const D1_ROW_LIMIT = 2_000_000;
const PAGE_LIMIT = 1_500_000;
const REPOSITORIES = 61;
const DAYS = 90;
const DIMENSIONS = ["commits", "issues", "prs", "actions", "releases", "alerts"] as const;
const bytes = (value: string) => new TextEncoder().encode(value).length;
const name = (index: number) => `owner/repository-${String(index).padStart(3, "0")}`;

/** Local SQLite ignores D1's 2MB string/row ceiling, so reject oversized bindings here. */
function budgeted(raw: D1Database): D1Database {
	const underlying = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
	const bind = (sql: string, values: unknown[]) => {
		const prepared = raw.prepare(sql);
		return values.length ? prepared.bind(...(values as never[])) : prepared;
	};
	const guard = (sql: string, values: unknown[]) => {
		for (const value of values)
			if (typeof value === "string" && bytes(value) > D1_ROW_LIMIT)
				throw new Error(`d1_row_limit: ${bytes(value)} bytes bound to ${sql.slice(0, 60)}`);
	};
	const statement = (sql: string, values: unknown[] = []): D1PreparedStatement => {
		const prepared = bind(sql, values);
		const wrapped = {
			bind: (...next: unknown[]) => {
				guard(sql, next);
				return statement(sql, next);
			},
			first: () => prepared.first(),
			all: () => prepared.all(),
			run: () => prepared.run(),
		} as unknown as D1PreparedStatement;
		underlying.set(wrapped, prepared);
		return wrapped;
	};
	return {
		prepare: (sql: string) => statement(sql),
		batch: async (statements: D1PreparedStatement[]) =>
			raw.batch(
				statements.map((entry) => {
					const prepared = underlying.get(entry);
					if (!prepared) throw new Error("foreign statement");
					return prepared;
				}),
			),
	} as unknown as D1Database;
}

/** `skipped` days omit the commit history alias, which the collector caches as unavailable. */
const repositoryNode = (index: number, skipped: (day: number) => boolean) => ({
	node: {
		id: `R_${index}`,
		nameWithOwner: name(index),
		name: `repository-${String(index).padStart(3, "0")}`,
		url: `https://github.com/${name(index)}`,
		description: null,
		isPrivate: false,
		isFork: false,
		createdAt: "2024-01-01T00:00:00Z",
		primaryLanguage: { name: "TypeScript" },
		defaultBranchRef: {
			name: "main",
			target: {
				oid: "head",
				history: { totalCount: 20 },
				...Object.fromEntries(
					Array.from({ length: DAYS }, (_, day) => [`day${day}`, { totalCount: day % 5 }]).filter(
						([alias]) => !skipped(Number(String(alias).slice(3))),
					),
				),
			},
		},
		issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
		pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
		openIssues: { totalCount: 0 },
		closedIssues: { totalCount: 0 },
		openPrs: { totalCount: 0 },
		closedPrs: { totalCount: 0 },
		mergedPrs: { totalCount: 0 },
		languages: { totalSize: 0, edges: [], pageInfo: { hasNextPage: false } },
		repositoryTopics: { nodes: [] },
		releases: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
	},
});

type AlertRows = { dependabot: unknown[]; code_scanning: unknown[] };
const noAlerts: AlertRows = { dependabot: [], code_scanning: [] };
const alertRows = (): AlertRows => {
	const common = (index: number, kind: string) => ({
		number: index + 1,
		state: "open",
		created_at: "2026-10-28T03:00:00Z",
		html_url: `https://github.com/${name(0)}/security/${kind}/${index + 1}`,
	});
	return {
		dependabot: Array.from({ length: 50 }, (_, index) => ({
			...common(index, "dependabot"),
			security_advisory: {
				summary: `Observed dependency vulnerability advisory ${index + 1} in a transitive package`,
				severity: "high",
			},
		})),
		code_scanning: Array.from({ length: 50 }, (_, index) => ({
			...common(index, "code-scanning"),
			rule: {
				description: `Observed code scanning rule violation ${index + 1} in generated sources`,
				security_severity_level: "medium",
			},
		})),
	};
};

function upstream(skipped: (day: number) => boolean, alerts: AlertRows = noAlerts) {
	const fetch = vi.fn(async (input: string, init?: RequestInit) => {
		if (input.endsWith("/graphql")) {
			const { variables } = JSON.parse(String(init?.body)) as { variables: { id: string } };
			return Response.json({ data: repositoryNode(Number(variables.id.slice(2)), skipped) });
		}
		if (input.includes("/actions/runs"))
			return Response.json({ workflow_runs: [], total_count: 0 });
		if (input.includes("/dependabot/alerts")) return Response.json(alerts.dependabot);
		if (input.includes("/code-scanning/alerts"))
			return alerts.code_scanning.length
				? Response.json(alerts.code_scanning)
				: Response.json({ message: "no analysis found" }, { status: 404 });
		return Response.json([]);
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}
afterEach(() => vi.unstubAllGlobals());

it("keeps 90 daily aggregates when distinct retained detail events exceed one D1 row", async () => {
	const { raw, context } = await fixture(1, () => false, false);
	context.run.params.dimensions = ["actions"];
	const rows = context.days.map((day) => ({
		day: day.date,
		dimension: "actions",
		status: "complete" as const,
		fetched_at: now,
		payload: JSON.stringify({
			count: 100,
			source: "github_rest_latest",
			since: day.since,
			until: day.until,
			items: Array.from({ length: 100 }, (_, index) => ({
				id: `${day.date}:${index}`,
				title: "Retained workflow run ".repeat(20),
				url: `https://github.com/${name(0)}/actions/runs/${day.date}-${index}`,
				at: day.since,
				createdAt: day.since,
				state: "completed",
				conclusion: "success",
			})),
		}),
	}));
	const db = createDb(raw);
	await db.batch(dayStatements(db, context, "R_0", rows));
	context.days = context.days.slice(-1);
	context.run.params.since = context.run.params.until;
	const fetch = upstream(() => false);
	expect(await collectRepository(context, name(0))).toMatchObject({ requests: 0 });
	expect(fetch).not.toHaveBeenCalled();
	const repo = (await published(raw)).snapshot.repos[0];
	expect(Object.keys(repo?.metrics.days ?? {})).toHaveLength(DAYS);
	expect(repo?.metrics.ciSuccess).toBe(100 * DAYS);
	expect(repo?.coverage.actions.status).toBe("complete");
	const saved = await raw
		.prepare("SELECT payload FROM refresh_resources WHERE stream='actions'")
		.first<{ payload: string }>();
	expect(bytes(saved?.payload ?? "")).toBeLessThanOrEqual(PAGE_LIMIT);
	const resource = JSON.parse(saved?.payload ?? "{}") as FactoryStreamData;
	expect(resource.items.length).toBeGreaterThan(0);
	expect(resource.items.length).toBeLessThan(100 * DAYS);
	expect(resource).toMatchObject({
		ranges: [],
		next: null,
		coverage: { status: "limited", reason: "storage_limit", completeWindows: [] },
	});
	await db.batch(
		await snapshots(db, "a", "repos", { repos: [{ id: "R_0", name_with_owner: name(0) }] }, now),
	);
	const detail = await readFactoryResource(db, "a", name(0), "actions");
	expect(detail).toMatchObject({
		truncated: true,
		coverage: resource.coverage,
		data: { ranges: [] },
	});
	const source = (await readSources(db, "a", {})).sources.find(
		(entry) => entry.resource === `factory:${name(0)}:actions`,
	);
	expect(source).toMatchObject({
		truncated: true,
		coverage: resource.coverage,
		contentVersion: detail.contentVersion,
	});
	const browser = await createApp().request(
		`http://localhost/api/factory/repos/${name(0)}/actions?scope=all`,
		{},
		{ ...context.env, ENVIRONMENT: "development" } as Env,
	);
	expect(browser.status).toBe(200);
	expect(await browser.json()).toMatchObject({ coverage: resource.coverage });
	const activity = await readActivity(db, "a", {});
	expect(activity.repos[0]?.coverage.actions).toMatchObject({
		status: "partial",
		truncated: true,
		reason: "storage_limit",
	});
});

it("marks a single oversized UTF-8 detail unavailable for exact enumeration without inventing a continuation", async () => {
	const { raw, context } = await fixture(1, () => false, false);
	const db = createDb(raw);
	const payload: FactoryStreamData = {
		runId: context.run.id,
		items: [
			{
				id: "large",
				title: "界".repeat(600_000),
				url: "https://github.com/owner/project",
				at: now,
				createdAt: now,
				closedAt: null,
				mergedAt: null,
				author: null,
				state: "open",
			},
		],
		next: null,
		ranges: [],
		coverage: {
			status: "complete",
			pages: 1,
			fetchedAt: now,
			source: "github",
			reason: null,
			observed: 1,
			inventoryComplete: true,
		},
	};
	await db.batch([await resourceStatement(db, context, "R_0", "issues", payload)]);
	const saved = await raw
		.prepare("SELECT payload FROM refresh_resources WHERE stream='issues'")
		.first<{ payload: string }>();
	expect(bytes(saved?.payload ?? "")).toBeLessThanOrEqual(PAGE_LIMIT);
	expect(JSON.parse(saved?.payload ?? "{}")).toMatchObject({
		items: [],
		next: null,
		ranges: [],
		coverage: {
			status: "limited",
			inventoryComplete: false,
			reason: "storage_limit",
			completeWindows: [],
		},
	});
});

async function fixture(
	repositories: number,
	skipped: (day: number) => boolean,
	collecting = true,
	alerts: AlertRows = noAlerts,
): Promise<{ raw: D1Database; context: CollectionContext }> {
	const raw = budgeted(sqliteFixture());
	const insert = (sql: string, ...values: (string | number | null)[]) =>
		raw
			.prepare(sql)
			.bind(...values)
			.run();
	await insert(
		"INSERT INTO accounts(id,login,avatar_url,token_ciphertext,token_last4,key_version,scopes,capabilities,is_active,created_at,updated_at) VALUES('a','owner','','encrypted','test',1,'','{}',1,?,?)",
		now,
		now,
	);
	await insert(
		"INSERT INTO refresh_accounts(account_id,payload,fetched_at) VALUES('a',?,?)",
		JSON.stringify({
			schema: 1,
			account_id: "a",
			owner: "owner",
			inventory: { total: repositories, scanned: repositories, complete: true, excluded: [] },
			contributionStatus: "complete",
			contribution: {
				days: [],
				total: 0,
				restricted: 0,
				fetchedAt: now,
				observedAt: now,
				timezone: "github",
				typesStatus: "partial",
			},
			repos: [],
		}),
		now,
	);
	for (let index = 0; index < repositories; index += 1)
		await insert(
			"INSERT INTO refresh_catalog(account_id,repo_id,repo,discovered_day,timezone,payload,fetched_at,active) VALUES('a',?,?,'2026-07-31','Asia/Shanghai',?,?,1)",
			`R_${index}`,
			name(index),
			JSON.stringify({ id: `R_${index}`, nameWithOwner: name(index) }),
			now,
		);
	const params: RefreshParams = {
		since: "2026-07-31",
		until: "2026-10-28",
		timezone: "Asia/Shanghai",
		dimensions: [...DIMENSIONS],
		force: false,
		lookbackDays: DAYS,
	};
	const context = {
		env: { DB: raw, ENVIRONMENT: "test", GITHUB_API_BASE: "http://github.test" },
		account: { id: "a", login: "owner" },
		token: "memory-only-fake-token",
		run: { id: "run-lookback", accountId: "a", params, requests: 0, createdAt: now },
		days: refreshDays(params),
		now,
	} as unknown as CollectionContext;
	if (collecting) await collect(context, repositories, skipped, alerts);
	return { raw, context };
}

async function collect(
	context: CollectionContext,
	repositories: number,
	skipped: (day: number) => boolean,
	alerts: AlertRows = noAlerts,
) {
	const stub = upstream(skipped, alerts);
	for (let index = 0; index < repositories; index += 1)
		await collectRepository(context, name(index));
	expect(stub).toHaveBeenCalledTimes(repositories * 4);
}

async function published(raw: D1Database) {
	const row = await raw
		.prepare("SELECT payload FROM refresh_publications WHERE account_id='a'")
		.first<{ payload: string }>();
	const pages = await raw
		.prepare(
			"SELECT kind,payload,content_meta FROM refresh_snapshots WHERE account_id='a' AND kind LIKE 'factory%' ORDER BY kind",
		)
		.all<SnapshotPage>();
	return {
		publication: JSON.parse(row?.payload ?? "{}") as { repos: { id: string; name: string }[] },
		publicationBytes: bytes(row?.payload ?? ""),
		pages: pages.results,
		snapshot: assemblePages("factory", pages.results) as unknown as FactorySnapshot,
	};
}

it("compacts lookback windows so all 61 repositories survive D1 publication", async () => {
	const { raw, context } = await fixture(REPOSITORIES, () => false);
	const result = await published(raw);
	const first = context.days[0];
	const last = context.days.at(-1);
	const span = {
		since: first?.since,
		until: new Date(Date.parse(String(last?.until)) - 1).toISOString(),
		timezone: "Asia/Shanghai",
	};
	expect(result.snapshot.repos).toHaveLength(REPOSITORIES);
	expect(result.snapshot.repos.map((repo) => repo.name)).toEqual(
		Array.from({ length: REPOSITORIES }, (_, index) => name(index)),
	);
	for (const repo of result.snapshot.repos)
		for (const dimension of DIMENSIONS) {
			expect(repo.coverage[dimension].completeWindows).toEqual([span]);
			expect(repo.coverage[dimension].fetchedAt).toBe(now);
		}
	expect(Object.keys(result.snapshot.repos[0]?.metrics.days ?? {})).toHaveLength(DAYS);
	expect(result.snapshot.repos[0]?.metrics.commits).toBe(
		Array.from({ length: DAYS }, (_, day) => day % 5).reduce((sum, value) => sum + value, 0),
	);
	expect(result.snapshot.repos[0]?.coverage.alerts).toMatchObject({
		status: "unavailable",
		observed: 0,
		reason: "not_found",
	});
	expect(result.publication.repos.map((repo) => repo.name)).toEqual(
		Array.from({ length: REPOSITORIES }, (_, index) => name(index)),
	);
	expect(result.publicationBytes).toBeLessThanOrEqual(D1_ROW_LIMIT);
	expect(result.pages.every((page) => bytes(page.payload) <= PAGE_LIMIT)).toBe(true);
	const repoBytes = result.snapshot.repos.reduce(
		(sum, repo) => sum + bytes(JSON.stringify(repo)),
		0,
	);
	console.log(
		`lookback-capacity ${JSON.stringify({
			repositories: REPOSITORIES,
			days: DAYS,
			dimensions: DIMENSIONS.length,
			publicationBytes: result.publicationBytes,
			snapshotBytes: result.pages.reduce((sum, page) => sum + bytes(page.payload), 0),
			repoBytes,
			factoryPages: result.pages.length,
			factoryPageBytes: result.pages.map((page) => bytes(page.payload)),
		})}`,
	);
	const daily = {
		...context,
		days: context.days.slice(-1),
		run: {
			...context.run,
			id: "run-daily",
			params: { ...context.run.params, since: context.run.params.until },
		},
	};
	const fetch = upstream(() => false);
	const started = performance.now();
	for (let index = 0; index < REPOSITORIES; index += 1)
		expect(await collectRepository(daily, name(index))).toMatchObject({
			requests: 1,
			partial: false,
		});
	const elapsed = performance.now() - started;
	expect(fetch).toHaveBeenCalledTimes(REPOSITORIES);
	const cached = await published(raw);
	for (const repo of cached.snapshot.repos) {
		expect(Object.keys(repo.metrics.days)).toHaveLength(DAYS);
		for (const dimension of DIMENSIONS)
			expect(repo.coverage[dimension].completeWindows).toEqual([span]);
	}
	console.log(
		`cached-daily-history ${JSON.stringify({ repositories: REPOSITORIES, elapsedMs: elapsed, perRepoMs: elapsed / REPOSITORIES })}`,
	);
	const next = {
		...daily,
		now: "2026-10-30T04:00:00.000Z",
		run: {
			...daily.run,
			id: "run-next-day",
			params: { ...daily.run.params, since: "2026-10-29", until: "2026-10-29" },
		},
	};
	next.days = refreshDays(next.run.params);
	expect(await collectRepository(next, name(0))).toMatchObject({ partial: false });
	const advanced = (await published(raw)).snapshot.repos[0];
	expect(Object.keys(advanced?.metrics.days ?? {})).toHaveLength(DAYS);
	expect(advanced?.metrics.days["2026-07-31"]).toBeUndefined();
	expect(advanced?.metrics.days["2026-10-29"]).toBeDefined();
	expect(advanced?.coverage.commits.completeWindows).toEqual([
		{ ...span, since: "2026-07-31T16:00:00.000Z", until: "2026-10-29T15:59:59.999Z" },
	]);
	expect(
		await raw
			.prepare(
				"SELECT COUNT(DISTINCT day) AS count FROM refresh_day_observations WHERE repo_id='R_0'",
			)
			.first(),
	).toEqual({ count: DAYS + 1 });
	const oldDay = {
		...next,
		days: context.days.slice(0, 1),
		run: { ...next.run, params: { ...next.run.params, since: "2026-07-31", until: "2026-07-31" } },
	};
	fetch.mockClear();
	expect(await collectRepository(oldDay, name(0))).toMatchObject({ requests: 1, partial: false });
	expect(fetch).toHaveBeenCalledTimes(1);
	expect((await published(raw)).snapshot.repos[0]?.metrics).toEqual(advanced?.metrics);
}, 15_000);

it("keeps unreachable-day gaps and unavailable windows separate and reports the reachable worst case", async () => {
	const skipped = (day: number) => day % 2 === 0;
	const { raw, context } = await fixture(REPOSITORIES, skipped);
	const result = await published(raw);
	const commitWindows = result.snapshot.repos[0]?.coverage.commits.completeWindows ?? [];
	const expected = context.days
		.map((day, index) => ({ day, index }))
		.filter(({ index }) => !skipped(index))
		.map(({ day }) => ({
			since: day.since,
			until: new Date(Date.parse(day.until) - 1).toISOString(),
			timezone: "Asia/Shanghai",
		}));
	expect(commitWindows).toEqual(expected);
	expect(commitWindows).toHaveLength(DAYS / 2);
	expect(result.snapshot.repos[0]?.coverage.commits).toMatchObject({
		status: "partial",
		observed: DAYS / 2,
		reason: "missing_days",
	});
	for (const dimension of DIMENSIONS.filter((dimension) => dimension !== "commits"))
		expect(result.snapshot.repos[0]?.coverage[dimension].completeWindows).toHaveLength(1);
	expect(result.snapshot.repos).toHaveLength(REPOSITORIES);
	expect(result.publicationBytes).toBeLessThanOrEqual(D1_ROW_LIMIT);
	expect(result.pages.every((page) => bytes(page.payload) <= PAGE_LIMIT)).toBe(true);
	const perRepoBytes = Math.round(
		result.snapshot.repos.reduce((sum, repo) => sum + bytes(JSON.stringify(repo)), 0) /
			REPOSITORIES,
	);
	console.log(
		`lookback-fragmented ${JSON.stringify({
			repositories: REPOSITORIES,
			skippedCommitDays: DAYS / 2,
			commitWindows: commitWindows.length,
			publicationBytes: result.publicationBytes,
			snapshotBytes: result.pages.reduce((sum, page) => sum + bytes(page.payload), 0),
			d1RowLimit: D1_ROW_LIMIT,
			perRepoBytes,
			perWindowBytes: bytes(JSON.stringify(commitWindows[0])),
			factoryPages: result.pages.length,
		})}`,
	);
});

it("pages a fully fragmented 61-repository publication without losing repositories", async () => {
	const { raw, context } = await fixture(REPOSITORIES, () => false, false);
	const windows = context.days
		.filter((_, index) => index % 2 === 0)
		.map((day) => ({
			since: day.since,
			until: new Date(Date.parse(day.until) - 1).toISOString(),
			timezone: "Asia/Shanghai",
		}));
	const fragmented = (index: number) =>
		JSON.stringify({
			id: `R_${index}`,
			name: name(index),
			url: `https://github.com/${name(index)}`,
			coverage: {
				...Object.fromEntries(
					DIMENSIONS.map((dimension) => [
						dimension,
						{
							status: "complete",
							pages: 1,
							fetchedAt: now,
							source: "github_graphql",
							observed: DAYS,
							reason: null,
							completeWindows: windows,
						},
					]),
				),
				dependencies: {
					status: "unavailable",
					pages: 0,
					fetchedAt: null,
					source: "unavailable",
					observed: 0,
					reason: "dependency_analysis_unavailable",
				},
			},
			observation: {
				version: "run-lookback",
				window: { since: windows[0]?.since, until: windows.at(-1)?.until },
				refreshedAt: now,
			},
			metrics: {
				...blankMetrics(),
				days: Object.fromEntries(context.days.map((day) => [day.date, blankDay()])),
			},
		});
	const seeded = Array.from({ length: REPOSITORIES }, (_, index) => fragmented(index));
	console.log(
		`lookback-fragmented-seed ${JSON.stringify({
			repositories: REPOSITORIES,
			windowsPerDimension: windows.length,
			dimensions: DIMENSIONS.length,
			seededBytes: seeded.reduce((sum, payload) => sum + bytes(payload), 0),
		})}`,
	);
	for (const [index, payload] of seeded.entries())
		await raw
			.prepare(
				"INSERT INTO refresh_repository_publications(account_id,repo_id,payload,fetched_at) VALUES('a',?,?,?)",
			)
			.bind(`R_${index}`, payload, now)
			.run();
	await publish(createDb(raw), context);
	const result = await published(raw);
	const snapshotBytes = result.pages.reduce((sum, page) => sum + bytes(page.payload), 0);
	expect(result.pages).toHaveLength(2);
	expect(result.pages.every((page) => bytes(page.payload) <= PAGE_LIMIT)).toBe(true);
	expect(snapshotBytes).toBeGreaterThan(D1_ROW_LIMIT);
	expect(result.snapshot.repos).toHaveLength(REPOSITORIES);
	expect(result.snapshot.repos.map((repo) => repo.name)).toEqual(
		Array.from({ length: REPOSITORIES }, (_, index) => name(index)),
	);
	for (const repo of result.snapshot.repos)
		for (const dimension of DIMENSIONS)
			expect(repo.coverage[dimension].completeWindows).toEqual(windows);
	expect(result.publication.repos.map((repo) => repo.name)).toEqual(
		Array.from({ length: REPOSITORIES }, (_, index) => name(index)),
	);
	expect(result.publicationBytes).toBeLessThanOrEqual(D1_ROW_LIMIT);
	console.log(
		`lookback-fragmented-store ${JSON.stringify({
			repositories: REPOSITORIES,
			windowsPerDimension: windows.length,
			dimensions: DIMENSIONS.length,
			snapshotBytes,
			factoryPageBytes: result.pages.map((page) => bytes(page.payload)),
			publicationBytes: result.publicationBytes,
			d1RowLimit: D1_ROW_LIMIT,
		})}`,
	);
});

it("writes non-empty 90-day alert observations through the real collector within D1 limits", async () => {
	const { raw } = await fixture(1, () => false, true, alertRows());
	const result = await published(raw);
	const days = await raw
		.prepare(
			"SELECT dimension,COUNT(*) AS rows,SUM(length(CAST(payload AS BLOB))) AS bytes FROM refresh_day_observations WHERE account_id='a' GROUP BY dimension ORDER BY dimension",
		)
		.all<{ dimension: string; rows: number; bytes: number }>();
	const observationBytes = days.results.reduce((sum, row) => sum + row.bytes, 0);
	expect(days.results.every((row) => row.rows === DAYS)).toBe(true);
	expect(observationBytes).toBeGreaterThan(D1_ROW_LIMIT);
	const alerts = await raw
		.prepare(
			"SELECT payload FROM refresh_day_observations WHERE account_id='a' AND dimension='alerts' ORDER BY day LIMIT 1",
		)
		.first<{ payload: string }>();
	const evidence = JSON.parse(alerts?.payload ?? "{}") as {
		items: { id: string; title: string; severity: string | null }[];
		unavailable: boolean;
	};
	expect(evidence.items).toHaveLength(100);
	expect(evidence.items[0]).toMatchObject({
		title: "Observed dependency vulnerability advisory 1 in a transitive package",
		severity: "high",
	});
	expect(evidence.items.at(-1)).toMatchObject({
		title: "Observed code scanning rule violation 50 in generated sources",
		severity: "medium",
	});
	expect(evidence.unavailable).toBe(false);
	expect(result.snapshot.repos[0]?.coverage.alerts).toMatchObject({
		status: "complete",
		observed: 1,
		source: "github_rest_latest",
	});
	expect(result.publicationBytes).toBeLessThanOrEqual(D1_ROW_LIMIT);
	expect(result.pages.every((page) => bytes(page.payload) <= PAGE_LIMIT)).toBe(true);
	console.log(
		`lookback-alert-observations ${JSON.stringify({
			days: DAYS,
			alertItemsPerDay: evidence.items.length,
			alertRows: days.results.find((row) => row.dimension === "alerts")?.rows,
			observationBytes,
			dayStatements: Math.ceil(observationBytes / PAGE_LIMIT),
			publicationBytes: result.publicationBytes,
			factoryPageBytes: result.pages.map((page) => bytes(page.payload)),
			d1RowLimit: D1_ROW_LIMIT,
		})}`,
	);
});
