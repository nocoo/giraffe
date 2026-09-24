import { REPO_SNAPSHOT_TABS, SITE_SNAPSHOT_KINDS } from "../../lib/snapshot-kinds";
import {
	type Collected,
	clampToBudget,
	collectKind,
	collectRepos,
	MAX_STAGED_BYTES,
} from "./collect";
import { touchLastUsedStmt } from "./db/accounts";
import type { Db } from "./db/d1";
import { pruneDaysStmt } from "./db/snapshot-days";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { ApiError } from "./errors";
import { type GithubClient, MAX_FETCHES } from "./github-client";
import type { Capabilities } from "./github-map";
import { buildInsights, type InsightAlert, type RepoRow } from "./insights";
import { repoPolicy } from "./repo-statistics";
import { assemblePages, physicalKinds, splitPages } from "./snapshot-pages";

const ALL = SITE_SNAPSHOT_KINDS;
const DERIVED = new Set(["insights"]);
const CROSS = new Set<string>(ALL);
const SUFFIX = new Set<string>(REPO_SNAPSHOT_TABS);

export function assertKind(kind: string): void {
	if (CROSS.has(kind) || DERIVED.has(kind)) {
		return;
	}
	const match = /^repo:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+):([a-z]+)$/.exec(kind);
	if (!match?.[1] || !match[2] || !match[3] || !SUFFIX.has(match[3])) {
		throw new ApiError(400, "validation_failed", "unknown kind");
	}
	if (match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") {
		throw new ApiError(400, "validation_failed", "invalid repo kind");
	}
}

export function expandKinds(raw: "all" | string[] | undefined): string[] {
	if (raw === undefined || raw === "all") {
		return [...ALL];
	}
	if (raw.length === 0 || raw.length > 16) {
		throw new ApiError(400, "validation_failed", "invalid kinds");
	}
	if (new Set(raw).size !== raw.length) {
		throw new ApiError(400, "validation_failed", "duplicate kinds");
	}
	for (const kind of raw) {
		assertKind(kind);
	}
	return raw;
}

function githubOrder(kinds: string[]): string[] {
	const github = kinds.filter((kind) => !DERIVED.has(kind));
	const rest = github.filter((kind) => kind !== "repos");
	return github.includes("repos") ? ["repos", ...rest] : rest;
}

function parseCaps(raw: string): Capabilities {
	try {
		return JSON.parse(raw) as Capabilities;
	} catch {
		return { repo: false, "read:org": false, "read:user": false, notifications: false };
	}
}

function assertCaps(kind: string, caps: Capabilities): void {
	if (DERIVED.has(kind)) {
		return;
	}
	if (kind === "notifications") {
		if (!caps.notifications) {
			throw new ApiError(409, "capability_missing", "notifications scope missing");
		}
		return;
	}
	if (!caps.repo) {
		throw new ApiError(409, "capability_missing", "repo scope missing");
	}
}

function needsRepoNames(kind: string): boolean {
	return kind === "issues" || kind === "prs" || kind === "alerts";
}

export function assertRefreshCapabilities(raw: string, kinds: string[]) {
	const caps = parseCaps(raw);
	for (const kind of kinds) assertCaps(kind, caps);
}

function asRepos(payload: Collected): RepoRow[] {
	const rows = payload.repos;
	if (!Array.isArray(rows)) {
		return [];
	}
	return rows.map((row) => {
		const r = row as Record<string, unknown>;
		return {
			name_with_owner: String(r.name_with_owner ?? ""),
			open_issue_count: Number(r.open_issue_count ?? 0),
			pushed_at: typeof r.pushed_at === "string" ? r.pushed_at : null,
		};
	});
}

function sourceOk(payload: Collected | null): boolean {
	return payload !== null && payload.truncated !== true;
}

/** Prepare only: the caller chooses the transaction, including the factory lease fence. */
export async function prepareRefresh(
	db: Db,
	accountId: string,
	gh: GithubClient,
	token: string,
	requested: string[],
	fetchedAt: string,
	written: Record<string, Collected> = {},
	measureBytes = false,
) {
	async function loaded(kind: string): Promise<Collected | null> {
		const current = written[kind];
		if (current) {
			return current;
		}
		const snap = await readSnapshot(db, accountId, kind);
		return snap as Collected | null;
	}

	async function repoNames(): Promise<string[]> {
		const payload = await loaded("repos");
		const repos = payload?.repos;
		if (!payload || !Array.isArray(repos)) {
			throw new ApiError(409, "snapshot_missing", "repos snapshot missing");
		}
		return repos
			.map((row) => String((row as { name_with_owner?: string }).name_with_owner ?? ""))
			.filter(Boolean);
	}

	let used = 0;
	let stop = false;
	for (const kind of githubOrder(requested)) {
		if (written[kind]) continue;
		if (stop) {
			break;
		}
		const remaining = MAX_STAGED_BYTES - used;
		let payload: Collected =
			kind === "repos"
				? await collectRepos(gh, token, remaining)
				: await collectKind(
						gh,
						token,
						kind,
						needsRepoNames(kind) ? await repoNames() : [],
						remaining,
					);
		if (needsRepoNames(kind)) {
			const reposPayload = await loaded("repos");
			if (reposPayload?.truncated === true) {
				payload = { ...payload, truncated: true };
			}
		}
		payload = { ...payload, fetched_at: fetchedAt };
		const clamped = clampToBudget(payload, MAX_STAGED_BYTES - used, kind);
		if (clamped.capped && clamped.bytes === 0) {
			stop = true;
			break;
		}
		const preview = splitPages(kind, clamped.payload);
		written[kind] = { ...assemblePages(kind, preview.pages), truncated: preview.truncated };
		used += clamped.bytes;
		if (clamped.capped || gh.count >= MAX_FETCHES || used >= MAX_STAGED_BYTES) {
			stop = true;
		}
	}

	if (requested.some((kind) => CROSS.has(kind) || DERIVED.has(kind))) {
		const explicitInsights = requested.includes("insights");
		const reposSrc = await loaded("repos");
		const issuesSrc = await loaded("issues");
		const alertsSrc = await loaded("alerts");
		const policy = await repoPolicy(db, accountId, reposSrc);
		const insightsOk = sourceOk(reposSrc) && sourceOk(issuesSrc);
		if (explicitInsights && !insightsOk) {
			throw new ApiError(409, "snapshot_missing", "derived sources missing");
		}
		if (insightsOk && reposSrc) {
			const alertsIncomplete =
				alertsSrc === null || alertsSrc.unavailable === true || alertsSrc.truncated === true;
			const insights = buildInsights(
				asRepos(reposSrc).filter((r) => policy.enabled(r.name_with_owner)),
				Array.isArray(alertsSrc?.items) ? (alertsSrc.items as InsightAlert[]) : [],
				fetchedAt,
				alertsIncomplete,
			);
			const preview = splitPages("insights", insights);
			if (!preview.truncated || explicitInsights) {
				written.insights = {
					...assemblePages("insights", preview.pages),
					truncated: preview.truncated,
				};
			}
		}
	}

	const stmts = [];
	let bytes = 0;
	for (const [kind, payload] of Object.entries(written)) {
		const preview = splitPages(kind, payload);
		payload.truncated = preview.truncated;
		bytes += preview.pages.reduce(
			(sum, page) => sum + new TextEncoder().encode(page.payload).length,
			0,
		);
		stmts.push(...replaceSnapshotStmts(db, accountId, kind, payload, fetchedAt));
	}
	const kinds = Object.keys(written).flatMap(physicalKinds);
	if (measureBytes && kinds.length) {
		const old = await db
			.prepare(
				`SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM snapshots WHERE account_id=? AND kind IN (${kinds.map(() => "?").join(",")})`,
			)
			.bind(accountId, ...kinds)
			.first<{ bytes: number }>();
		bytes -= old?.bytes ?? 0;
	}
	const cutoff = new Date(Date.parse(fetchedAt) - 29 * 86_400_000).toISOString().slice(0, 10);
	stmts.push(pruneDaysStmt(db, accountId, cutoff));
	if (gh.count > 0) {
		stmts.push(touchLastUsedStmt(db, accountId, fetchedAt));
	}
	return { written, stmts, bytes };
}
