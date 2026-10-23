import { mergeMetrics, summarizeEvents } from "../../lib/factory";
import type { FactorySnapshot, FactoryStreamData } from "../../lib/factory-types";
import { type Collected, MAX_STAGED_BYTES } from "./collect";
import type { Db } from "./db/d1";
import { fenced, type RunLease } from "./db/factory-runs";
import { ApiError } from "./errors";
import { type FactoryStore, factoryNext, stepFactory, streamKey } from "./factory-collect";
import { coverage, type GithubObject, object } from "./factory-map";
import { boundedJson } from "./factory-publish";
import { assertFactoryReserve, recordFactoryRate } from "./factory-rate";
import { type GithubClient, MAX_FETCHES } from "./github-client";
import { mapActionRuns } from "./github-map";
import {
	GithubUnavailableError,
	githubUnavailability,
	unavailableReason,
} from "./github-unavailable";

type Source = {
	status: "partial" | "complete" | "limited" | "unavailable";
	next: string | null;
	pages: number;
	observed: number;
	expected: number;
	bytes: number;
	strategy?: "incremental";
	incremental?: {
		runId: string;
		baselinePages: number;
		since: string;
		retained: number;
		total: number | null;
		next: string | null;
		pages: number;
		observed: number;
		expected: number | null;
		bytes: number;
	};
	error?: { status: number; code: string; reasonCode?: GithubUnavailableError["reasonCode"] };
};
type SourcePage = { runs: GithubObject[]; next: string | null };
const SOURCE = "actions-source";
const DELTA = "actions-incremental";
const RERUN_WINDOW_MS = 30 * 86400_000;
class InvalidActionsSource extends ApiError {
	constructor() {
		super(422, "snapshot_incomplete", "Actions source malformed; previous data retained");
	}
}
const RAW_FIELDS = [
	"id",
	"node_id",
	"sha",
	"number",
	"title",
	"name",
	"tag_name",
	"html_url",
	"created_at",
	"closed_at",
	"merged_at",
	"state",
	"status",
	"conclusion",
	"event",
	"head_branch",
	"head_sha",
	"workflow_id",
	"run_attempt",
	"run_started_at",
	"updated_at",
	"path",
] as const;

function firstPage(repo: string) {
	return `/repos/${repo}/actions/runs?per_page=100`;
}

function countLowerBound(value: unknown): number {
	if (typeof value === "string" && /^\d+\+$/.test(value)) return Number.parseInt(value, 10) + 1;
	const count = Number(value);
	return Number.isFinite(count) && count > 0 ? count : 0;
}

function rawRun(run: GithubObject): GithubObject {
	const retained: GithubObject = {};
	for (const key of RAW_FIELDS) if (key in run) retained[key] = run[key];
	for (const key of ["user", "author", "actor"])
		if (key in run) retained[key] = run[key] == null ? run[key] : { login: object(run[key]).login };
	return retained;
}

async function readSource(db: Db, lease: RunLease, repo: string): Promise<Source> {
	const row = await db
		.prepare("SELECT payload FROM factory_resources WHERE run_id=? AND repo=? AND stream=?")
		.bind(lease.run.id, repo, SOURCE)
		.first<{ payload: string }>();
	if (row) {
		const source = JSON.parse(row.payload) as Source;
		if (source.pages) delete source.incremental;
		return source;
	}
	const incremental = await incrementalSource(db, lease, repo);
	return {
		status: "partial",
		next: firstPage(repo),
		pages: 0,
		observed: 0,
		expected: 0,
		bytes: 0,
		...(incremental ? { incremental } : {}),
	};
}

async function baselineRuns(db: Db, lease: RunLease, repo: string, runId: string, count: number) {
	const pages = await readSourcePages(db, lease, repo, runId);
	const runs: GithubObject[] = [];
	try {
		for (let index = 0; index < count; index++) {
			const page = decodePage(pages.get(index));
			if (
				!page ||
				!Array.isArray(page.runs) ||
				page.runs.some((run) => !run || typeof run !== "object" || Array.isArray(run))
			)
				return null;
			runs.push(...page.runs);
		}
	} catch (error) {
		if (
			error instanceof SyntaxError ||
			(error instanceof ApiError && error.code === "snapshot_incomplete")
		)
			return null;
		throw error;
	}
	return runs;
}

async function incrementalSource(
	db: Db,
	lease: RunLease,
	repo: string,
): Promise<Source["incremental"]> {
	const identity = lease.run.repoIds[repo];
	if (!identity) return;
	const row = await db
		.prepare(
			"SELECT f.payload,r.id AS runId,r.created_at AS observedAt FROM factory_repo_state s JOIN factory_repo_versions v ON v.account_id=s.account_id AND v.repo=s.repo AND v.version=s.version JOIN factory_runs r ON r.account_id=s.account_id AND r.id=s.version JOIN factory_resources f ON f.run_id=r.id AND f.repo=s.repo AND f.stream=? WHERE s.account_id=? AND s.repo=? AND json_extract(v.payload,'$.id')=? AND r.id!=? AND r.status IN ('completed','partial')",
		)
		.bind(SOURCE, lease.run.account_id, repo, identity, lease.run.id)
		.first<{ payload: string; runId: string; observedAt: string }>();
	if (!row) return;
	const baseline = JSON.parse(row.payload) as Source;
	const observed = Date.parse(row.observedAt);
	if (
		baseline.status !== "complete" ||
		baseline.error ||
		baseline.incremental ||
		!Number.isSafeInteger(baseline.pages) ||
		baseline.pages < 1 ||
		baseline.pages > MAX_FETCHES ||
		!Number.isFinite(observed) ||
		observed >= Date.parse(lease.run.startedAt)
	)
		return;
	const runs = await baselineRuns(db, lease, repo, row.runId, baseline.pages);
	if (
		!runs ||
		runs.length !== baseline.observed ||
		baseline.expected > runs.length ||
		new Set(runs.map((run) => run.id)).size !== runs.length ||
		runs.some(
			(run) =>
				!Number.isSafeInteger(run.id) ||
				Number(run.id) <= 0 ||
				!Number.isFinite(Date.parse(String(run.created_at))),
		)
	)
		return;
	let cutoff = observed - RERUN_WINDOW_MS - 1000;
	for (const run of runs) {
		const started = Date.parse(String(run.run_started_at));
		if (
			run.status !== "completed" ||
			!run.conclusion ||
			!Number.isFinite(started) ||
			started >= cutoff
		)
			cutoff = Math.min(cutoff, Date.parse(String(run.created_at)));
	}
	const retained = runs.filter((run) => Date.parse(String(run.created_at)) < cutoff).length;
	if (!retained) return;
	return {
		runId: row.runId,
		baselinePages: baseline.pages,
		since: new Date(cutoff).toISOString(),
		retained,
		total: null,
		next: null,
		pages: 0,
		observed: 0,
		expected: null,
		bytes: 0,
	};
}

function writeSource(
	db: Db,
	lease: RunLease,
	repo: string,
	key: string,
	value: unknown,
	now: string,
) {
	return fenced(
		db,
		lease,
		now,
		"INSERT INTO factory_resources(run_id,repo,stream,payload) SELECT ?,?,?,? WHERE $guard ON CONFLICT(run_id,repo,stream) DO UPDATE SET payload=excluded.payload",
		[lease.run.id, repo, key, boundedJson(value)],
	);
}

function pagePrefix(index: number, kind = SOURCE) {
	return `${kind}:${String(index).padStart(3, "0")}:`;
}

function pageWrites(
	db: Db,
	lease: RunLease,
	repo: string,
	index: number,
	page: SourcePage,
	now: string,
	kind = SOURCE,
) {
	const encoded = JSON.stringify(page);
	const writes: D1PreparedStatement[] = [];
	for (let offset = 0; offset < encoded.length; offset += 250_000)
		writes.push(
			writeSource(
				db,
				lease,
				repo,
				`${pagePrefix(index, kind)}${String(offset / 250_000).padStart(3, "0")}`,
				encoded.slice(offset, offset + 250_000),
				now,
			),
		);
	return writes;
}

function clearDelta(db: Db, lease: RunLease, repo: string, now: string) {
	return fenced(
		db,
		lease,
		now,
		"DELETE FROM factory_resources WHERE run_id=? AND repo=? AND substr(stream,1,?)=? AND $guard",
		[lease.run.id, repo, DELTA.length + 1, `${DELTA}:`],
	);
}

async function incrementPage(
	db: Db,
	lease: RunLease,
	repo: string,
	source: Source,
	page: SourcePage,
	payload: GithubObject,
	now: string,
) {
	const delta = source.incremental;
	if (!delta) return null;
	const total = payload.total_count;
	if (delta.total === null) {
		if (
			!Number.isSafeInteger(total) ||
			Number(total) < delta.retained ||
			Number(total) - delta.retained > 1000 ||
			!page.next
		) {
			delete source.incremental;
			return null;
		}
		delta.total = Number(total);
		delta.next = `/repos/${repo}/actions/runs?created=>=${delta.since}&per_page=100`;
		return { writes: [writeSource(db, lease, repo, SOURCE, source, now)] };
	}
	const restart = () => {
		delete source.incremental;
		return {
			writes: [clearDelta(db, lease, repo, now), writeSource(db, lease, repo, SOURCE, source, now)],
		};
	};
	if (
		!Number.isSafeInteger(total) ||
		Number(total) < 0 ||
		Number(total) > 1000 ||
		(delta.expected !== null && total !== delta.expected)
	)
		return restart();
	delta.expected = Number(total);
	delta.observed += page.runs.length;
	delta.bytes += new TextEncoder().encode(JSON.stringify(page)).length;
	delta.pages++;
	delta.next = page.next;
	if (
		delta.bytes > MAX_STAGED_BYTES ||
		(delta.pages >= MAX_FETCHES && page.next) ||
		delta.observed > delta.expected
	)
		return restart();
	if (page.next)
		return {
			writes: [
				...pageWrites(db, lease, repo, delta.pages - 1, page, now, DELTA),
				writeSource(db, lease, repo, SOURCE, source, now),
			],
		};
	const chunks = await readSourcePages(db, lease, repo, lease.run.id, DELTA);
	const fresh: GithubObject[] = [];
	for (let index = 0; index < delta.pages; index++)
		fresh.push(...(index === delta.pages - 1 ? page : decodePage(chunks.get(index))).runs);
	const baseline = await baselineRuns(db, lease, repo, delta.runId, delta.baselinePages);
	const since = Date.parse(delta.since);
	if (
		!baseline ||
		delta.observed !== delta.expected ||
		fresh.length !== delta.observed ||
		new Set(fresh.map((run) => run.id)).size !== fresh.length ||
		fresh.some(
			(run) =>
				!Number.isSafeInteger(run.id) ||
				Number(run.id) <= 0 ||
				!(Date.parse(String(run.created_at)) >= since),
		)
	)
		return restart();
	const retained = baseline.filter((run) => Date.parse(String(run.created_at)) < since);
	const runs = [...fresh, ...retained];
	if (
		retained.length !== delta.retained ||
		runs.length !== delta.total ||
		new Set(runs.map((run) => run.id)).size !== runs.length ||
		runs.length > MAX_FETCHES * 100
	)
		return restart();
	const materialized: SourcePage[] = [];
	for (let index = 0; index < Math.max(1, Math.ceil(runs.length / 100)); index++)
		materialized.push({
			runs: runs.slice(index * 100, (index + 1) * 100),
			next: (index + 1) * 100 < runs.length ? `${firstPage(repo)}&page=${index + 2}` : null,
		});
	const bytes = materialized.reduce(
		(sum, current) => sum + new TextEncoder().encode(JSON.stringify(current)).length,
		0,
	);
	if (bytes > MAX_STAGED_BYTES) return restart();
	Object.assign(source, {
		status: "complete",
		next: null,
		pages: materialized.length,
		observed: runs.length,
		expected: delta.total,
		bytes,
		strategy: "incremental",
	});
	delete source.incremental;
	return {
		materialized,
		writes: [
			clearDelta(db, lease, repo, now),
			...materialized.flatMap((current, index) => pageWrites(db, lease, repo, index, current, now)),
			writeSource(db, lease, repo, SOURCE, source, now),
		],
	};
}

async function readPage(db: Db, lease: RunLease, repo: string, index: number): Promise<SourcePage> {
	const prefix = pagePrefix(index);
	const chunks = await db
		.prepare(
			"SELECT payload FROM factory_resources WHERE run_id=? AND repo=? AND substr(stream,1,?)=? ORDER BY stream",
		)
		.bind(lease.run.id, repo, prefix.length, prefix)
		.all<{ payload: string }>();
	if (!chunks.results.length)
		throw new ApiError(422, "snapshot_incomplete", "Actions source page missing");
	return JSON.parse(
		chunks.results.map((chunk) => JSON.parse(chunk.payload) as string).join(""),
	) as SourcePage;
}

async function fetchPage(
	db: Db,
	lease: RunLease,
	repo: string,
	source: Source,
	gh: GithubClient,
	token: string,
	now: string,
) {
	const writes: D1PreparedStatement[] = [];
	let page: SourcePage | null = null;
	let materialized: SourcePage[] | undefined;
	let headers = new Headers();
	try {
		const path = source.incremental?.next ?? source.next ?? firstPage(repo);
		const response = await gh.githubApi(token, path);
		headers = response.headers;
		let payload: GithubObject;
		try {
			payload = object(await response.json());
			const runs = payload.workflow_runs;
			if (
				!Array.isArray(runs) ||
				runs.some((run) => !run || typeof run !== "object" || Array.isArray(run))
			)
				throw new InvalidActionsSource();
			page = { runs: runs.map(rawRun), next: factoryNext(headers.get("link"), path) };
		} catch {
			throw new InvalidActionsSource();
		}
		const encoded = JSON.stringify(page);
		if (token && encoded.includes(token))
			throw new ApiError(422, "snapshot_incomplete", "Actions source contains credentials");
		const incremental = await incrementPage(db, lease, repo, source, page, payload, now);
		if (incremental) {
			materialized = incremental.materialized;
			return { page: materialized?.[0] ?? null, materialized, headers, writes: incremental.writes };
		}
		source.bytes += new TextEncoder().encode(encoded).length;
		source.observed += page.runs.length;
		source.expected = Math.max(source.expected, countLowerBound(payload.total_count));
		source.next = page.next;
		source.pages++;
		source.status = source.next ? "partial" : "complete";
		if (
			source.bytes > MAX_STAGED_BYTES ||
			(source.next && source.pages >= MAX_FETCHES) ||
			(!source.next && source.observed < source.expected)
		) {
			source.status = "limited";
			source.next = null;
		} else {
			writes.push(...pageWrites(db, lease, repo, source.pages - 1, page, now));
		}
	} catch (error) {
		if (
			!(error instanceof ApiError) ||
			(!githubUnavailability(error) &&
				error.code !== "github_response_too_large" &&
				!(error instanceof InvalidActionsSource))
		)
			throw error;
		source.status =
			source.pages ||
			error.code === "github_response_too_large" ||
			error instanceof InvalidActionsSource
				? "limited"
				: "unavailable";
		source.next = null;
		source.error = {
			status: error.status,
			code: error.code,
			...(error instanceof GithubUnavailableError ? { reasonCode: error.reasonCode } : {}),
		};
	}
	writes.push(writeSource(db, lease, repo, SOURCE, source, now));
	return { page, materialized, headers, writes };
}

function filteredClient(gh: GithubClient): GithubClient {
	return {
		...gh,
		get count() {
			return gh.count;
		},
		async githubApi(token, path, init) {
			const response = await gh.githubApi(token, path, init);
			const payload = object(await response.json());
			return Response.json(
				{ ...payload, total_count: countLowerBound(payload.total_count) },
				{ headers: response.headers },
			);
		},
	};
}

function sourceError(error: NonNullable<Source["error"]>) {
	return error.reasonCode
		? new GithubUnavailableError(
				error.status,
				unavailableReason(error.reasonCode).reason,
				error.reasonCode === "permission_denied",
			)
		: new ApiError(error.status, error.code, "GitHub resource unavailable");
}

export async function stepActions(
	db: Db,
	lease: RunLease,
	snapshot: FactorySnapshot,
	gh: GithubClient,
	token: string,
	store: FactoryStore,
	now: string,
): Promise<D1PreparedStatement[]> {
	assertFactoryReserve(snapshot, now);
	const repo = snapshot.repos[snapshot.cursor.repo];
	if (!repo) throw new ApiError(409, "snapshot_missing", "Actions repository missing");
	const saved =
		repo.coverage.actions.status === "pending"
			? null
			: await store.read(streamKey(repo.name, "actions"));
	if (saved && saved.coverage.source !== firstPage(repo.name)) {
		await stepFactory(snapshot, filteredClient(gh), token, store, now);
		return [];
	}
	const source = await readSource(db, lease, repo.name);
	if (source.status === "limited" && !source.error) {
		await stepFactory(snapshot, filteredClient(gh), token, store, now);
		return [];
	}
	const index = saved?.coverage.pages ?? 0;
	let page: SourcePage | null = null;
	let headers = new Headers();
	let writes: D1PreparedStatement[] = [];
	const before = gh.count;
	try {
		if (index < source.pages && !source.error) page = await readPage(db, lease, repo.name, index);
		else if (source.status === "partial") {
			const fetched = await fetchPage(db, lease, repo.name, source, gh, token, now);
			({ page, headers, writes } = fetched);
		}
		if (!page && source.status === "partial") {
			repo.coverage.actions = {
				...repo.coverage.actions,
				status: "partial",
				source: firstPage(repo.name),
				fetchedAt: now,
				strategy: source.incremental ? "incremental" : "full",
			};
			snapshot.fetched_at = now;
			snapshot.revision++;
			return writes;
		}
		if (source.error?.code === "snapshot_incomplete") {
			const data: FactoryStreamData = saved ?? {
				runId: snapshot.runId,
				items: [],
				next: null,
				ranges: [],
				coverage: coverage(firstPage(repo.name)),
			};
			data.next = null;
			data.ranges = [];
			Object.assign(data.coverage, {
				status: "limited",
				fetchedAt: now,
				strategy: "full",
				reason: "Actions source malformed; previous data retained",
				observed: data.items.length,
			});
			repo.coverage.actions = data.coverage;
			repo.metrics = mergeMetrics([
				repo.metrics,
				summarizeEvents("actions", data.items, snapshot.window),
			]);
			snapshot.cursor.stream++;
			snapshot.fetched_at = now;
			snapshot.revision++;
			await store.write(streamKey(repo.name, "actions"), data);
			return writes;
		}
		if (source.status === "limited" && !source.error) {
			const first = `/repos/${repo.name}/actions/runs?created=${snapshot.window.since}..${snapshot.window.until}&per_page=100&page=1`;
			const data = {
				runId: snapshot.runId,
				items: [],
				next: first,
				ranges: [],
				coverage: {
					...coverage(first),
					status: "partial" as const,
					strategy: "full" as const,
					fetchedAt: now,
				},
			};
			repo.coverage.actions = data.coverage;
			await store.write(streamKey(repo.name, "actions"), data);
			snapshot.fetched_at = now;
			snapshot.revision++;
			return writes;
		}
		const client: GithubClient = {
			...gh,
			get count() {
				return gh.count;
			},
			async githubApi() {
				if (source.error) throw sourceError(source.error);
				if (!page) throw new ApiError(422, "snapshot_incomplete", "Actions source page missing");
				return Response.json(
					{ workflow_runs: page.runs },
					{
						headers: page.next ? { link: `<https://api.github.com${page.next}>; rel="next"` } : {},
					},
				);
			},
		};
		await stepFactory(
			snapshot,
			client,
			token,
			{
				...store,
				write: async (key, data) => {
					data.coverage.source = firstPage(repo.name);
					if (source.strategy) data.coverage.strategy = source.strategy;
					await store.write(key, data);
				},
			},
			now,
		);
		return writes;
	} finally {
		snapshot.requests += gh.count - before;
		const remaining = headers.get("x-ratelimit-remaining");
		const reset = headers.get("x-ratelimit-reset");
		if (remaining !== null)
			recordFactoryRate(snapshot, {
				remaining: Number(remaining),
				resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : null,
				resource: "core",
				observedAt: now,
			});
	}
}

export async function collectActionsSnapshot(
	db: Db,
	lease: RunLease,
	repo: string,
	gh: GithubClient,
	token: string,
	now: string,
): Promise<{ writes: D1PreparedStatement[]; payload?: Collected }> {
	const source = await readSource(db, lease, repo);
	let writes: D1PreparedStatement[] = [];
	let page: SourcePage | null = null;
	let materialized: SourcePage[] | undefined;
	if (source.status === "partial")
		({ writes, page, materialized } = await fetchPage(db, lease, repo, source, gh, token, now));
	if (source.error && source.status === "unavailable") throw sourceError(source.error);
	if (source.status === "limited")
		throw new ApiError(
			422,
			"snapshot_incomplete",
			"Actions history incomplete; previous snapshot retained",
		);
	if (source.status !== "complete") return { writes };
	const pages = materialized ? new Map<number, string[]>() : await readSourcePages(db, lease, repo);
	const runs: unknown[] = [];
	for (let index = 0; index < source.pages; index++) {
		const current =
			materialized?.[index] ??
			(page && index === source.pages - 1 ? page : decodePage(pages.get(index)));
		runs.push(...mapActionRuns({ workflow_runs: current.runs }));
	}
	return { writes, payload: { runs, truncated: false, fetched_at: now } };
}

async function readSourcePages(
	db: Db,
	lease: RunLease,
	repo: string,
	runId = lease.run.id,
	kind = SOURCE,
) {
	const prefix = `${kind}:`;
	const chunks = await db
		.prepare(
			"SELECT stream,payload FROM factory_resources WHERE run_id=? AND repo=? AND substr(stream,1,?)=? ORDER BY stream",
		)
		.bind(runId, repo, prefix.length, prefix)
		.all<{ stream: string; payload: string }>();
	const pages = new Map<number, string[]>();
	for (const chunk of chunks.results) {
		const index = Number(chunk.stream.slice(prefix.length).split(":")[0]);
		const parts = pages.get(index) ?? [];
		parts.push(JSON.parse(chunk.payload) as string);
		pages.set(index, parts);
	}
	return pages;
}

function decodePage(parts: string[] | undefined): SourcePage {
	if (!parts) throw new ApiError(422, "snapshot_incomplete", "Actions source page missing");
	return JSON.parse(parts.join("")) as SourcePage;
}

export async function cachedActionsClient(
	db: Db,
	lease: RunLease,
	repo: string,
	upstream: GithubClient,
): Promise<GithubClient> {
	const source = await readSource(db, lease, repo);
	if (source.status !== "complete") return upstream;
	let successful: GithubObject[] | undefined;
	return {
		...upstream,
		get count() {
			return upstream.count;
		},
		get graphqlErrors() {
			return upstream.graphqlErrors;
		},
		async githubApi(token, path, init) {
			const url = new URL(path, "https://api.github.com");
			if (
				init ||
				url.origin !== "https://api.github.com" ||
				url.pathname !== `/repos/${repo}/actions/runs` ||
				url.searchParams.get("status") !== "success" ||
				[...url.searchParams.keys()].some((key) => !["status", "per_page", "page"].includes(key))
			)
				return upstream.githubApi(token, path, init);
			const page = Number(url.searchParams.get("page") ?? 1);
			const size = Number(url.searchParams.get("per_page") ?? 30);
			if (
				!Number.isSafeInteger(page) ||
				page < 1 ||
				!Number.isSafeInteger(size) ||
				size < 1 ||
				size > 100
			)
				throw new ApiError(502, "github_error", "invalid Actions cache pagination");
			if (!successful) {
				const pages = await readSourcePages(db, lease, repo);
				successful = [];
				for (let index = 0; index < source.pages; index++)
					successful.push(
						...decodePage(pages.get(index)).runs.filter((run) => run.conclusion === "success"),
					);
			}
			const runs = successful.slice((page - 1) * size, page * size);
			const headers = new Headers();
			if (page * size < successful.length) {
				url.searchParams.set("page", String(page + 1));
				headers.set("link", `<${url.href}>; rel="next"`);
			}
			return Response.json({ total_count: successful.length, workflow_runs: runs }, { headers });
		},
	};
}
