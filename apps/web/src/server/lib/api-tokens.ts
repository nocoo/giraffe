import type { z } from "zod";
import {
	type ApiScope,
	type ApiToken,
	type ApiTokenPrincipal,
	type AuthorizationCode,
	apiScopesSchema,
	type CreatedApiToken,
	createApiTokenSchema,
	createAuthorizationCodeSchema,
	exchangeAuthorizationCodeSchema,
	updateApiTokenSchema,
} from "../../lib/api-access";
import type { Db } from "./db/d1";
import { ApiError } from "./errors";
import { createId } from "./id";

const TOKEN_COLUMNS =
	"id,account_id,label,scopes,creator,created_at,expires_at,revoked_at,last_used_at";
type TokenRow = Omit<ApiToken, "scopes"> & { scopes: string };
type GrantRow = {
	account_id: string;
	label: string;
	scopes: string;
	creator: string;
	expires_in_days: number;
};

function parseInput<Output>(schema: z.ZodType<Output>, input: unknown): Output {
	const parsed = schema.safeParse(input);
	if (!parsed.success) {
		throw new ApiError(400, "validation_failed", "Invalid API access request");
	}
	return parsed.data;
}

function parseScopes(scopes: string): ApiScope[] {
	try {
		return apiScopesSchema.parse(JSON.parse(scopes));
	} catch {
		throw new ApiError(500, "db_error", "Invalid API access record");
	}
}

function publicToken(row: TokenRow): ApiToken {
	return { ...row, scopes: parseScopes(row.scopes) };
}

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function randomSecret(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hashSecret(value: string): Promise<string> {
	return Array.from(await sha256(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requireAccount(db: Db, accountId: string): Promise<void> {
	const account = await db.prepare("SELECT id FROM accounts WHERE id=?").bind(accountId).first();
	if (!account) throw new ApiError(404, "account_not_found", "Account not found");
}

async function mintToken(input: z.output<typeof createApiTokenSchema>, now: string) {
	const token = `giraffe_${randomSecret()}`;
	const created: CreatedApiToken = {
		id: createId(),
		account_id: input.accountId,
		label: input.label,
		scopes: input.scopes,
		creator: input.creator,
		created_at: now,
		expires_at: new Date(Date.parse(now) + input.expiresInDays * 86_400_000).toISOString(),
		revoked_at: null,
		last_used_at: null,
		token,
	};
	return { created, hash: await hashSecret(token) };
}

export async function createApiToken(
	db: Db,
	input: unknown,
	now = new Date().toISOString(),
): Promise<CreatedApiToken> {
	const parsed = parseInput(createApiTokenSchema, input);
	await requireAccount(db, parsed.accountId);
	const { created, hash } = await mintToken(parsed, now);
	await db
		.prepare(`INSERT INTO api_tokens(${TOKEN_COLUMNS},token_hash) VALUES(?,?,?,?,?,?,?,?,?,?)`)
		.bind(
			created.id,
			created.account_id,
			created.label,
			JSON.stringify(created.scopes),
			created.creator,
			created.created_at,
			created.expires_at,
			null,
			null,
			hash,
		)
		.run();
	return created;
}

export async function listApiTokens(db: Db, accountId: string): Promise<ApiToken[]> {
	const rows = await db
		.prepare(
			`SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE account_id=? ORDER BY created_at DESC,id DESC`,
		)
		.bind(accountId)
		.all<TokenRow>();
	return rows.results.map(publicToken);
}

export async function updateApiToken(
	db: Db,
	accountId: string,
	id: string,
	input: unknown,
	now = new Date().toISOString(),
): Promise<ApiToken | null> {
	const parsed = parseInput(updateApiTokenSchema, input);
	const row = await db
		.prepare(
			`SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE account_id=? AND id=? AND revoked_at IS NULL AND expires_at>?`,
		)
		.bind(accountId, id, now)
		.first<TokenRow>();
	if (!row) return null;
	const current = publicToken(row);
	const scopes = parsed.scopes ?? current.scopes;
	if (scopes.some((scope) => !current.scopes.includes(scope))) {
		throw new ApiError(403, "scope_escalation", "Token scopes can only be reduced");
	}
	const label = parsed.label ?? current.label;
	const updated = await db
		.prepare(
			"UPDATE api_tokens SET label=?,scopes=? WHERE account_id=? AND id=? AND label=? AND scopes=? AND revoked_at IS NULL AND expires_at>?",
		)
		.bind(label, JSON.stringify(scopes), accountId, id, row.label, row.scopes, now)
		.run();
	if (updated.meta.changes !== 1) {
		throw new ApiError(409, "token_changed", "Token changed; reload before updating");
	}
	return { ...current, label, scopes };
}

export async function revokeApiToken(
	db: Db,
	accountId: string,
	id: string,
	now = new Date().toISOString(),
): Promise<boolean> {
	const revoked = await db
		.prepare("UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE account_id=? AND id=?")
		.bind(now, accountId, id)
		.run();
	return revoked.meta.changes === 1;
}

export async function recordApiTokenUse(
	db: Db,
	accountId: string,
	id: string,
	now = new Date().toISOString(),
): Promise<boolean> {
	const used = await db
		.prepare(
			"UPDATE api_tokens SET last_used_at=? WHERE account_id=? AND id=? AND revoked_at IS NULL AND expires_at>? AND (last_used_at IS NULL OR last_used_at<?)",
		)
		.bind(now, accountId, id, now, now)
		.run();
	return used.meta.changes === 1;
}

export async function authenticateApiToken(
	db: Db,
	authorization: string | null | undefined,
	now = new Date().toISOString(),
): Promise<ApiTokenPrincipal | null> {
	const match = authorization?.match(/^Bearer (giraffe_[A-Za-z0-9_-]{43})$/i);
	const token = match?.[1];
	if (!token || match?.[0] !== authorization) return null;
	const row = await db
		.prepare(
			"SELECT id,account_id,scopes,expires_at FROM api_tokens WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?",
		)
		.bind(await hashSecret(token), now)
		.first<Pick<TokenRow, "id" | "account_id" | "scopes" | "expires_at">>();
	return row
		? {
				id: row.id,
				accountId: row.account_id,
				scopes: parseScopes(row.scopes),
				expiresAt: row.expires_at,
			}
		: null;
}

export async function createAuthorizationCode(
	db: Db,
	input: unknown,
	now = new Date().toISOString(),
): Promise<AuthorizationCode> {
	const parsed = parseInput(createAuthorizationCodeSchema, input);
	await requireAccount(db, parsed.accountId);
	const code = `giraffe_code_${randomSecret()}`;
	const expiresAt = new Date(Date.parse(now) + 5 * 60_000).toISOString();
	await db.batch([
		db
			.prepare(
				"DELETE FROM api_authorization_codes WHERE code_hash IN (SELECT code_hash FROM api_authorization_codes WHERE expires_at<=? ORDER BY expires_at LIMIT 100)",
			)
			.bind(now),
		db
			.prepare(
				"INSERT INTO api_authorization_codes(code_hash,account_id,label,scopes,creator,expires_in_days,redirect_uri,code_challenge,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
			)
			.bind(
				await hashSecret(code),
				parsed.accountId,
				parsed.label,
				JSON.stringify(parsed.scopes),
				parsed.creator,
				parsed.expiresInDays,
				parsed.redirectUri,
				parsed.codeChallenge,
				now,
				expiresAt,
			),
	]);
	return { code, redirectUri: parsed.redirectUri, state: parsed.state, expiresAt };
}

export async function exchangeAuthorizationCode(
	db: Db,
	input: unknown,
	now = new Date().toISOString(),
): Promise<CreatedApiToken> {
	const parsed = parseInput(exchangeAuthorizationCodeSchema, input);
	const codeHash = await hashSecret(parsed.code);
	const codeChallenge = base64url(await sha256(parsed.codeVerifier));
	const grant = await db
		.prepare(
			"SELECT account_id,label,scopes,creator,expires_in_days FROM api_authorization_codes WHERE code_hash=? AND redirect_uri=? AND code_challenge=? AND consumed_at IS NULL AND expires_at>?",
		)
		.bind(codeHash, parsed.redirectUri, codeChallenge, now)
		.first<GrantRow>();
	if (!grant) throw new ApiError(400, "invalid_grant", "Authorization code is invalid or expired");
	const { created, hash } = await mintToken(
		{
			accountId: grant.account_id,
			label: grant.label,
			scopes: parseScopes(grant.scopes),
			creator: grant.creator,
			expiresInDays: grant.expires_in_days,
		},
		now,
	);
	const [consumed, inserted] = await db.batch([
		db
			.prepare(
				"UPDATE api_authorization_codes SET consumed_at=?,token_id=? WHERE code_hash=? AND redirect_uri=? AND code_challenge=? AND consumed_at IS NULL AND expires_at>?",
			)
			.bind(now, created.id, codeHash, parsed.redirectUri, codeChallenge, now),
		db
			.prepare(
				`INSERT INTO api_tokens(${TOKEN_COLUMNS},token_hash) SELECT ?,account_id,label,scopes,creator,?,?,NULL,NULL,? FROM api_authorization_codes WHERE code_hash=? AND token_id=? AND consumed_at=?`,
			)
			.bind(created.id, now, created.expires_at, hash, codeHash, created.id, now),
	]);
	if (consumed?.meta.changes !== 1 || inserted?.meta.changes !== 1) {
		throw new ApiError(400, "invalid_grant", "Authorization code is invalid or expired");
	}
	return created;
}
