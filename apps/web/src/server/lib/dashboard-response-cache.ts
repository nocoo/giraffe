import type { Context } from "hono";
import type { AppVars, Env } from "../env";
import { readActivity } from "./activity-store";
import { activityDataVersion } from "./dashboard-data-version";
import type { Db } from "./db/d1";
import { jsonOk } from "./errors";
import type { SourceTiming } from "./source-timing";

export type WarmRow = {
	data_version: string;
	etag: string;
	body: string;
};

export type DashboardBuildResult = {
	response: unknown;
	stored: unknown;
};

export type DashboardPatch = (stored: unknown) => unknown | Promise<unknown>;

export function dashboardCacheKey(route: string, parts: Record<string, string>): string {
	return `${route}?${Object.entries(parts)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, value]) => `${key}=${value}`)
		.join("&")}`;
}

async function digestVersion(version: string): Promise<string> {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(version));
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function etagFromDataVersion(version: string): Promise<string> {
	return `"${await digestVersion(version)}"`;
}

export function ifNoneMatchSatisfied(header: string | undefined, etag: string): boolean {
	if (!header) return false;
	const tags = header.split(",").map((value) => value.trim());
	if (tags.includes("*")) return true;
	const strong = etag.startsWith('"') ? etag : `"${etag}"`;
	return tags.some((tag) => tag === strong || tag === `W/${strong}`);
}

export function dashboardCacheControl(status: number): string {
	return status >= 400 ? "private, no-store" : "private, no-cache";
}

export function dashboardVary(machine: boolean): string {
	return machine ? "Authorization" : "Cookie, Cf-Access-Jwt-Assertion";
}

export function dashboardPrivateHeaders(status: number, machine: boolean): Record<string, string> {
	return {
		"cache-control": dashboardCacheControl(status),
		"referrer-policy": "no-referrer",
		vary: dashboardVary(machine),
	};
}

export async function readWarmRow(
	db: Db,
	accountId: string,
	cacheKey: string,
): Promise<WarmRow | null> {
	return db
		.prepare(
			"SELECT data_version,etag,body FROM dashboard_warm_responses WHERE account_id=? AND cache_key=?",
		)
		.bind(accountId, cacheKey)
		.first<WarmRow>();
}

export async function writeWarmRow(
	db: Db,
	accountId: string,
	cacheKey: string,
	version: string,
	etag: string,
	body: string,
	updatedAt: string,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO dashboard_warm_responses(account_id,cache_key,data_version,etag,body,updated_at)
 VALUES(?,?,?,?,?,?)
 ON CONFLICT(account_id,cache_key) DO UPDATE SET
  data_version=excluded.data_version,
  etag=excluded.etag,
  body=excluded.body,
  updated_at=excluded.updated_at`,
		)
		.bind(accountId, cacheKey, version, etag, body, updatedAt)
		.run();
}

export async function pruneWarmRows(db: Db, accountId: string, keepKeys: string[]): Promise<void> {
	if (!keepKeys.length) return;
	const placeholders = keepKeys.map(() => "?").join(",");
	await db
		.prepare(
			`DELETE FROM dashboard_warm_responses WHERE account_id=? AND cache_key NOT IN (${placeholders})`,
		)
		.bind(accountId, ...keepKeys)
		.run();
}

export async function invalidateDashboardWarmCache(db: Db, accountId: string): Promise<void> {
	await db.prepare("DELETE FROM dashboard_warm_responses WHERE account_id=?").bind(accountId).run();
}

type RespondOptions = {
	accountId: string;
	cacheKey: string;
	machine: boolean;
	version: () => Promise<string>;
	build: () => Promise<DashboardBuildResult>;
	patch?: DashboardPatch;
	timing?: SourceTiming;
};

export async function respondDashboardCached<Variables extends AppVars>(
	c: Context<{ Bindings: Env; Variables: Variables }>,
	options: RespondOptions,
): Promise<Response> {
	const db = c.get("db");
	const timing = options.timing ?? c.get("sourceTiming");
	const version = await options.version();
	const etag = await etagFromDataVersion(version);
	const warm = await readWarmRow(db, options.accountId, options.cacheKey);
	const ifNoneMatch = c.req.header("If-None-Match");
	const headers = dashboardPrivateHeaders(200, options.machine);

	const finish = (body: unknown, tag: string) => {
		if (ifNoneMatchSatisfied(ifNoneMatch, tag)) {
			return new Response(null, { status: 304, headers: { ...headers, etag: tag } });
		}
		return jsonOk(body, 200, { ...headers, etag: tag }, timing);
	};

	if (warm?.data_version === version) {
		const stored = JSON.parse(warm.body) as unknown;
		const body = options.patch ? await options.patch(stored) : stored;
		return finish(body, warm.etag);
	}

	const built = await options.build();
	const stored = built.stored;
	const storedText = timing ? timing.stringify(stored) : JSON.stringify(stored);
	try {
		await writeWarmRow(
			db,
			options.accountId,
			options.cacheKey,
			version,
			etag,
			storedText,
			new Date().toISOString(),
		);
	} catch {
		// Profiling harnesses and read-only replicas skip warm persistence.
	}
	const response = options.patch ? await options.patch(stored) : built.response;
	return finish(response, etag);
}

export async function storeWarmDashboardBody(
	db: Db,
	accountId: string,
	cacheKey: string,
	version: string,
	body: unknown,
): Promise<void> {
	const etag = await etagFromDataVersion(version);
	const bodyText = JSON.stringify(body);
	await writeWarmRow(db, accountId, cacheKey, version, etag, bodyText, new Date().toISOString());
}

export async function respondActivityDashboardCached<Variables extends AppVars>(
	c: Context<{ Bindings: Env; Variables: Variables }>,
	options: {
		accountId: string;
		query: Record<string, string[]>;
		queryKey: string;
		machine: boolean;
	},
): Promise<Response> {
	const db = c.get("db");
	const cacheKey = dashboardCacheKey(
		options.machine ? "machine:/accounts/activity" : "browser:/api/activity",
		options.queryKey ? { q: options.queryKey } : {},
	);
	return respondDashboardCached(c, {
		accountId: options.accountId,
		cacheKey,
		machine: options.machine,
		version: () => activityDataVersion(db, options.accountId, options.queryKey),
		build: async () => {
			const body = await readActivity(db, options.accountId, options.query);
			return { response: body, stored: body };
		},
	});
}
