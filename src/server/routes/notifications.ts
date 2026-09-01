import type { Context } from "hono";
import { z } from "zod";
import type { AppVars, Env } from "../env";
import { encryptionKey } from "../env";
import { getActiveAccount, touchLastUsedStmt } from "../lib/db/accounts";
import { readSnapshot, replaceSnapshotStmts } from "../lib/db/snapshots";
import { ApiError, jsonOk } from "../lib/errors";
import { createGithubClient } from "../lib/github-client";
import { readJson } from "../lib/read-body";
import { assemblePages, splitPages } from "../lib/snapshot-pages";
import { decryptToken, parseKeyBytes } from "../lib/token-crypto";

const readSchema = z.object({
	id: z.string().regex(/^[0-9]{1,20}$/),
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

async function loadAccount(c: Context<{ Bindings: Env; Variables: AppVars }>) {
	const db = c.get("db");
	const account = await getActiveAccount(db);
	if (!account) {
		throw new ApiError(409, "account_missing", "no active account");
	}
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

async function persist(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
	accountId: string,
	snap: Record<string, unknown>,
): Promise<Response> {
	const db = c.get("db");
	const fetchedAt = new Date().toISOString();
	const next = { ...snap, fetched_at: fetchedAt };
	const preview = splitPages("notifications", next);
	const assembled = {
		...assemblePages("notifications", preview.pages),
		truncated: preview.truncated,
	};
	const stmts = [
		...replaceSnapshotStmts(db, accountId, "notifications", assembled, fetchedAt),
		touchLastUsedStmt(db, accountId, fetchedAt),
	];
	await db.batch(stmts);
	return jsonOk(assembled);
}

export async function postRead(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
): Promise<Response> {
	const parsed = readSchema.safeParse(await readJson(c.req.raw, 65_536));
	if (!parsed.success) {
		throw new ApiError(400, "validation_failed", "invalid id");
	}
	const { db, account, snap, token } = await loadAccount(c);
	void db;
	const gh = createGithubClient(c.env);
	await gh.githubApi(token, `/notifications/threads/${parsed.data.id}`, { method: "PATCH" });
	const notifications = asList(snap).map((row) =>
		String(row.id) === parsed.data.id ? { ...row, unread: false } : row,
	);
	return persist(c, account.id, { ...snap, notifications });
}

export async function postReadAll(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
): Promise<Response> {
	const { account, snap, token } = await loadAccount(c);
	const gh = createGithubClient(c.env);
	await gh.githubApi(token, "/notifications", { method: "PUT" });
	const notifications = asList(snap).map((row) => ({ ...row, unread: false }));
	return persist(c, account.id, { ...snap, notifications });
}
