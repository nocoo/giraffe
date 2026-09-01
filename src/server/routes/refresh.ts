import type { Context } from "hono";
import { z } from "zod";
import type { AppVars, Env } from "../env";
import { encryptionKey } from "../env";
import {
	type Collected,
	clampToBudget,
	collectKind,
	collectRepos,
	MAX_STAGED_BYTES,
} from "../lib/collect";
import { getActiveAccount, touchLastUsedStmt } from "../lib/db/accounts";
import { pruneDaysStmt, readDay, upsertDayStmt } from "../lib/db/snapshot-days";
import { readSnapshot, replaceSnapshotStmts } from "../lib/db/snapshots";
import { buildDigest, type DayPayload, utcDay, yesterday } from "../lib/digest";
import { ApiError, jsonOk } from "../lib/errors";
import { createGithubClient } from "../lib/github-client";
import type { Capabilities } from "../lib/github-map";
import { buildInsights, type InsightAlert, type RepoRow } from "../lib/insights";
import { readJson } from "../lib/read-body";
import { assemblePages, splitPages } from "../lib/snapshot-pages";
import { decryptToken, parseKeyBytes } from "../lib/token-crypto";

const bodySchema = z.object({
	kinds: z.union([z.literal("all"), z.array(z.string())]).optional(),
});

const ALL = ["repos", "issues", "prs", "alerts", "notifications"] as const;
const DERIVED = new Set(["insights", "digest"]);
const CROSS = new Set<string>(ALL);
const SUFFIX = new Set([
	"details",
	"actions",
	"traffic",
	"security",
	"issues",
	"prs",
	"releases",
	"languages",
	"contributors",
]);

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

function expandKinds(raw: "all" | string[] | undefined): string[] {
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

function dayFrom(payload: Collected): DayPayload {
	const repos = Array.isArray(payload.repos)
		? (payload.repos as Array<Record<string, unknown>>)
		: [];
	return {
		stars: repos.reduce((n, r) => n + Number(r.stargazer_count ?? 0), 0),
		forks: repos.reduce((n, r) => n + Number(r.fork_count ?? 0), 0),
		open_issues: repos.reduce((n, r) => n + Number(r.open_issue_count ?? 0), 0),
		repos: repos.length,
		by_repo: repos.map((r) => ({
			name_with_owner: String(r.name_with_owner ?? ""),
			stars: Number(r.stargazer_count ?? 0),
			forks: Number(r.fork_count ?? 0),
			open_issues: Number(r.open_issue_count ?? 0),
		})),
	};
}

function sourceOk(payload: Collected | null): boolean {
	return payload !== null && payload.truncated !== true;
}

export async function postRefresh(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
): Promise<Response> {
	const parsed = bodySchema.safeParse(await readJson(c.req.raw, 65_536));
	if (!parsed.success) {
		throw new ApiError(400, "validation_failed", "invalid body");
	}
	const requested = expandKinds(parsed.data.kinds);
	const db = c.get("db");
	const account = await getActiveAccount(db);
	if (!account) {
		throw new ApiError(409, "account_missing", "no active account");
	}
	const secret = encryptionKey(c.env, account.key_version);
	if (!secret) {
		throw new ApiError(500, "encryption_misconfigured", "missing key");
	}
	const caps = parseCaps(account.capabilities);
	for (const kind of requested) {
		assertCaps(kind, caps);
	}
	const token = await decryptToken(account.token_ciphertext, parseKeyBytes(secret));
	const gh = createGithubClient(c.env);
	const fetchedAt = new Date().toISOString();
	const written: Record<string, Collected> = {};
	const accountId = account.id;

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
		if (stop) {
			break;
		}
		let payload =
			kind === "repos"
				? await collectRepos(gh, token)
				: await collectKind(gh, token, kind, needsRepoNames(kind) ? await repoNames() : []);
		if (needsRepoNames(kind)) {
			const reposPayload = await loaded("repos");
			if (reposPayload?.truncated === true) {
				payload = { ...payload, truncated: true };
			}
		}
		payload = { ...payload, fetched_at: fetchedAt };
		const clamped = clampToBudget(payload, MAX_STAGED_BYTES - used);
		const preview = splitPages(kind, clamped.payload);
		written[kind] = { ...assemblePages(kind, preview.pages), truncated: preview.truncated };
		used += clamped.bytes;
		if (clamped.capped) {
			stop = true;
		}
	}

	const explicitInsights = requested.includes("insights");
	const explicitDigest = requested.includes("digest");
	const reposSrc = await loaded("repos");
	const issuesSrc = await loaded("issues");
	const alertsSrc = await loaded("alerts");
	const insightsOk = sourceOk(reposSrc) && sourceOk(issuesSrc) && sourceOk(alertsSrc);
	if (explicitInsights && !insightsOk) {
		throw new ApiError(409, "snapshot_missing", "derived sources missing");
	}
	if (insightsOk && reposSrc && alertsSrc) {
		const insights = buildInsights(
			asRepos(reposSrc),
			Array.isArray(alertsSrc.items) ? (alertsSrc.items as InsightAlert[]) : [],
			fetchedAt,
		);
		const preview = splitPages("insights", insights);
		if (!preview.truncated || explicitInsights) {
			written.insights = { ...insights, truncated: preview.truncated };
		}
	}
	const today = utcDay(fetchedAt);
	const wroteRepos = Boolean(written.repos && written.repos.truncated !== true);
	const todayDay = wroteRepos
		? dayFrom(written.repos as Collected)
		: await readDay(db, accountId, today);
	const digestOk = sourceOk(reposSrc) && todayDay !== null;
	if (explicitDigest && !digestOk) {
		throw new ApiError(409, "snapshot_missing", "derived sources missing");
	}
	if (digestOk && reposSrc) {
		const day = dayFrom(reposSrc);
		const digest = buildDigest(
			day,
			await readDay(db, accountId, yesterday(utcDay(fetchedAt))),
			fetchedAt,
		);
		const preview = splitPages("digest", digest as unknown as Record<string, unknown>);
		if (!preview.truncated || explicitDigest) {
			written.digest = { ...digest, truncated: preview.truncated };
		}
	}

	const stmts = [];
	for (const [kind, payload] of Object.entries(written)) {
		const preview = splitPages(kind, payload);
		payload.truncated = preview.truncated;
		stmts.push(...replaceSnapshotStmts(db, accountId, kind, payload, fetchedAt));
	}
	if (written.repos && written.repos.truncated !== true) {
		stmts.push(upsertDayStmt(db, accountId, utcDay(fetchedAt), dayFrom(written.repos)));
	}
	const cutoff = new Date(Date.parse(fetchedAt) - 30 * 86_400_000).toISOString().slice(0, 10);
	stmts.push(pruneDaysStmt(db, accountId, cutoff));
	if (gh.count > 0) {
		stmts.push(touchLastUsedStmt(db, accountId, fetchedAt));
	}
	await db.batch(stmts);
	if (requested.length === 1) {
		return jsonOk(written[requested[0] as string]);
	}
	return jsonOk({
		fetched_at: fetchedAt,
		kinds: Object.keys(written),
		truncated_kinds: Object.keys(written).filter((kind) => written[kind]?.truncated === true),
	});
}
