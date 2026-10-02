import type { Context } from "hono";
import type { AppVars, Env } from "../env";
import { currentKeyVersion, encryptionKey } from "../env";
import {
	activateStmt,
	countAccounts,
	deactivateAllStmt,
	deleteAccountStmt,
	getAccount,
	getAccountByLogin,
	insertAccountStmt,
	listAccounts,
	upsertAccountStmt,
} from "../lib/db/accounts";
import { ApiError, jsonOk } from "../lib/errors";
import { createGithubClient } from "../lib/github-client";
import { mapUser, parseScopes, scopesMissingMessage } from "../lib/github-map";
import { createId } from "../lib/id";
import { readJson } from "../lib/read-body";
import { assertClassicPat, encryptToken, parseKeyBytes, tokenLast4 } from "../lib/token-crypto";

function publicAccount(row: {
	id: string;
	login: string;
	avatar_url: string;
	token_last4: string;
	scopes: string;
	capabilities: string;
	is_active: number;
}) {
	return {
		id: row.id,
		login: row.login,
		avatar_url: row.avatar_url,
		token_last4: row.token_last4,
		scopes: row.scopes,
		capabilities: JSON.parse(row.capabilities) as unknown,
		is_active: row.is_active === 1,
	};
}

export async function getAccounts(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
): Promise<Response> {
	const rows = await listAccounts(c.get("db"));
	return jsonOk({ accounts: rows.map(publicAccount) });
}

export async function postAccount(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
): Promise<Response> {
	const raw = await readJson(c.req.raw, 4096);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new ApiError(400, "validation_failed", "invalid body");
	}
	const body = raw as { token?: string };
	const token = typeof body.token === "string" ? body.token : "";
	assertClassicPat(token);
	const db = c.get("db");
	const gh = createGithubClient(c.env);
	const res = await gh.githubApi(token, "/user");
	const user = mapUser((await res.json()) as { login?: string; avatar_url?: string });
	const parsed = parseScopes(res.headers.get("X-OAuth-Scopes"));
	if (parsed.missing.length > 0) {
		throw new ApiError(400, "scopes_missing", scopesMissingMessage(parsed.missing));
	}
	const version = currentKeyVersion(c.env);
	const secret = encryptionKey(c.env, version);
	if (!secret || Number.isNaN(version)) {
		throw new ApiError(500, "encryption_misconfigured", "missing encryption key");
	}
	const now = new Date().toISOString();
	const envelope = await encryptToken(token, parseKeyBytes(secret));
	const existing = await getAccountByLogin(db, user.login);
	if (existing) {
		const row = {
			...existing,
			avatar_url: user.avatar_url,
			token_ciphertext: envelope,
			token_last4: tokenLast4(token),
			key_version: version,
			scopes: parsed.scopes,
			capabilities: JSON.stringify(parsed.capabilities),
			updated_at: now,
			last_used_at: now,
		};
		await db.batch([upsertAccountStmt(db, row)]);
		return jsonOk(publicAccount(row), 201);
	}
	const count = await countAccounts(db);
	const row = {
		id: createId(),
		login: user.login,
		avatar_url: user.avatar_url,
		token_ciphertext: envelope,
		token_last4: tokenLast4(token),
		key_version: version,
		scopes: parsed.scopes,
		capabilities: JSON.stringify(parsed.capabilities),
		is_active: count === 0 ? 1 : 0,
		created_at: now,
		updated_at: now,
		last_used_at: now,
	};
	try {
		await db.batch([insertAccountStmt(db, row)]);
		return jsonOk(publicAccount(row), 201);
	} catch {
		const raced = await getAccountByLogin(db, user.login);
		if (raced) {
			const updated = {
				...raced,
				avatar_url: user.avatar_url,
				token_ciphertext: envelope,
				token_last4: tokenLast4(token),
				key_version: version,
				scopes: parsed.scopes,
				capabilities: JSON.stringify(parsed.capabilities),
				updated_at: now,
				last_used_at: now,
			};
			await db.batch([upsertAccountStmt(db, updated)]);
			return jsonOk(publicAccount(updated), 201);
		}
		const countAgain = await countAccounts(db);
		const retry = { ...row, is_active: countAgain === 0 ? 1 : 0 };
		try {
			await db.batch([insertAccountStmt(db, retry)]);
			return jsonOk(publicAccount(retry), 201);
		} catch {
			throw new ApiError(500, "db_error", "account conflict");
		}
	}
}

export async function activateAccount(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
): Promise<Response> {
	const id = String(c.req.param("id"));
	const db = c.get("db");
	const row = await getAccount(db, id);
	if (!row) {
		throw new ApiError(404, "not_found", "account not found");
	}
	await db.batch([deactivateAllStmt(db), activateStmt(db, id, new Date().toISOString())]);
	return jsonOk({ id, is_active: true });
}

export async function removeAccount(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
): Promise<Response> {
	const id = String(c.req.param("id"));
	const db = c.get("db");
	const row = await getAccount(db, id);
	if (!row) {
		throw new ApiError(404, "not_found", "account not found");
	}
	await db.batch([deleteAccountStmt(db, id)]);
	return new Response(null, { status: 204 });
}
