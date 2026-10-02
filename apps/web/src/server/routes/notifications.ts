import type { Context } from "hono";
import { z } from "zod";
import type { AppVars, Env } from "../env";
import { encryptionKey } from "../env";
import { getActiveAccount, touchLastUsedStmt } from "../lib/db/accounts";
import { readSnapshot, replaceSnapshotStmts } from "../lib/db/snapshots";
import { ApiError, jsonOk } from "../lib/errors";
import { createGithubClient, MAX_FETCHES } from "../lib/github-client";
import { ACCOUNT_ID_RE } from "../lib/id";
import { readJson } from "../lib/read-body";
import { repoPolicy, statisticsSnapshot } from "../lib/repo-statistics";
import { assemblePages, splitPages } from "../lib/snapshot-pages";
import { type SnapshotScope, snapshotScope } from "../lib/snapshot-scope";
import { decryptToken, parseKeyBytes } from "../lib/token-crypto";

const readSchema = z.object({
	id: z.string().regex(/^[0-9]{1,20}$/),
	account_id: z.string().regex(ACCOUNT_ID_RE),
});
const readAllSchema = z.object({
	account_id: z.string().regex(ACCOUNT_ID_RE),
});

function asList(snap: Record<string, unknown>): Array<Record<string, unknown>> {
	const rows = snap.notifications;
	if (!Array.isArray(rows)) {
		return [];
	}
	return rows.flatMap((row) =>
		row && typeof row === "object" ? [row as Record<string, unknown>] : [],
	);
}

async function loadAccount(c: Context<{ Bindings: Env; Variables: AppVars }>, accountId: string) {
	const db = c.get("db");
	const account = await getActiveAccount(db);
	if (!account) {
		throw new ApiError(409, "account_missing", "no active account");
	}
	assertAccount(accountId, account.id);
	const snap = await readSnapshot(db, account.id, "notifications");
	if (!snap) {
		throw new ApiError(409, "snapshot_missing", "no snapshot");
	}
	const secret = encryptionKey(c.env, account.key_version);
	if (!secret) {
		throw new ApiError(500, "encryption_misconfigured", "missing key");
	}
	const token = await decryptToken(account.token_ciphertext, parseKeyBytes(secret));
	return { db, account, snap, token };
}

function assertAccount(accountId: string, activeId: string): void {
	if (accountId !== activeId) {
		throw new ApiError(409, "account_conflict", "account changed");
	}
}

async function persist(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
	accountId: string,
	snap: Record<string, unknown>,
	scope: SnapshotScope,
): Promise<Response> {
	const db = c.get("db");
	const fetchedAt = String(snap.fetched_at ?? "");
	const usedAt = new Date().toISOString();
	const preview = splitPages("notifications", snap);
	const assembled = {
		...assemblePages("notifications", preview.pages),
		truncated: preview.truncated,
	};
	const stmts = [
		...replaceSnapshotStmts(db, accountId, "notifications", assembled, fetchedAt),
		touchLastUsedStmt(db, accountId, usedAt),
	];
	await db.batch(stmts);
	return jsonOk({
		...(await statisticsSnapshot(db, accountId, "notifications", assembled, scope)),
		account_id: accountId,
	});
}

export async function postRead(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
): Promise<Response> {
	const scope = snapshotScope(c.req.queries("scope"));
	const parsed = readSchema.safeParse(await readJson(c.req.raw, 65_536));
	if (!parsed.success) {
		throw new ApiError(400, "validation_failed", "invalid id");
	}
	const { db, account, snap, token } = await loadAccount(c, parsed.data.account_id);
	if (scope === "starred") {
		const policy = await repoPolicy(db, account.id, undefined, scope);
		const selected = asList(snap).find((row) => String(row.id) === parsed.data.id);
		if (!selected || !policy.enabled(String(selected.name_with_owner ?? "")))
			throw new ApiError(404, "not_found", "notification outside selected scope");
	}
	const gh = createGithubClient(c.env);
	await gh.githubApi(token, `/notifications/threads/${parsed.data.id}`, { method: "PATCH" });
	const notifications = asList(snap).map((row) =>
		String(row.id) === parsed.data.id ? { ...row, unread: false } : row,
	);
	return persist(c, account.id, { ...snap, notifications }, scope);
}

export async function postReadAll(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
): Promise<Response> {
	const scope = snapshotScope(c.req.queries("scope"));
	const parsed = readAllSchema.safeParse(await readJson(c.req.raw, 65_536));
	if (!parsed.success) {
		throw new ApiError(400, "validation_failed", "invalid body");
	}
	const { db, account, snap, token } = await loadAccount(c, parsed.data.account_id);
	const gh = createGithubClient(c.env);
	const ids = new Set<string>();
	if (scope === "starred") {
		const policy = await repoPolicy(db, account.id, undefined, scope);
		for (const row of asList(snap))
			if (row.unread === true && policy.enabled(String(row.name_with_owner ?? "")))
				ids.add(String(row.id));
		if (ids.size > MAX_FETCHES)
			throw new ApiError(
				422,
				"notification_limit",
				"too many unread notifications; mark threads individually",
			);
		if ([...ids].some((id) => !/^[0-9]{1,20}$/.test(id)))
			throw new ApiError(422, "snapshot_invalid", "invalid saved notification id");
		for (const id of ids)
			await gh.githubApi(token, `/notifications/threads/${id}`, { method: "PATCH" });
		if (!ids.size)
			return jsonOk({
				...(await statisticsSnapshot(db, account.id, "notifications", snap, scope)),
				account_id: account.id,
			});
	} else {
		await gh.githubApi(token, "/notifications", { method: "PUT" });
	}
	const notifications = asList(snap).map((row) =>
		scope === "all" || ids.has(String(row.id)) ? { ...row, unread: false } : row,
	);
	return persist(c, account.id, { ...snap, notifications }, scope);
}
