import type { Db } from "./d1";

export type AccountRow = {
	id: string;
	login: string;
	avatar_url: string;
	token_ciphertext: string;
	token_last4: string;
	key_version: number;
	scopes: string;
	capabilities: string;
	is_active: number;
	created_at: string;
	updated_at: string;
	last_used_at: string | null;
};

export async function listAccounts(db: Db): Promise<AccountRow[]> {
	const result = await db.prepare("SELECT * FROM accounts ORDER BY login").all<AccountRow>();
	return result.results;
}

export async function getAccount(db: Db, id: string): Promise<AccountRow | null> {
	return db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<AccountRow>();
}

export async function getAccountByLogin(db: Db, login: string): Promise<AccountRow | null> {
	return db.prepare("SELECT * FROM accounts WHERE login = ?").bind(login).first<AccountRow>();
}

export async function getActiveAccount(db: Db): Promise<AccountRow | null> {
	return db.prepare("SELECT * FROM accounts WHERE is_active = 1").first<AccountRow>();
}

export async function countAccounts(db: Db): Promise<number> {
	const row = await db.prepare("SELECT COUNT(*) AS n FROM accounts").first<{ n: number }>();
	return row?.n ?? 0;
}

export function insertAccountStmt(db: Db, row: AccountRow): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO accounts (id, login, avatar_url, token_ciphertext, token_last4, key_version, scopes, capabilities, is_active, created_at, updated_at, last_used_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.login,
			row.avatar_url,
			row.token_ciphertext,
			row.token_last4,
			row.key_version,
			row.scopes,
			row.capabilities,
			row.is_active,
			row.created_at,
			row.updated_at,
			row.last_used_at,
		);
}

export function upsertAccountStmt(db: Db, row: AccountRow): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE accounts SET avatar_url=?, token_ciphertext=?, token_last4=?, key_version=?, scopes=?, capabilities=?, updated_at=?, last_used_at=? WHERE login=?`,
		)
		.bind(
			row.avatar_url,
			row.token_ciphertext,
			row.token_last4,
			row.key_version,
			row.scopes,
			row.capabilities,
			row.updated_at,
			row.last_used_at,
			row.login,
		);
}

export function deactivateAllStmt(db: Db): D1PreparedStatement {
	return db.prepare("UPDATE accounts SET is_active = 0");
}

export function activateStmt(db: Db, id: string, updatedAt: string): D1PreparedStatement {
	return db
		.prepare("UPDATE accounts SET is_active = 1, updated_at = ? WHERE id = ?")
		.bind(updatedAt, id);
}

export function deleteAccountStmt(db: Db, id: string): D1PreparedStatement {
	return db.prepare("DELETE FROM accounts WHERE id = ?").bind(id);
}

export function touchLastUsedStmt(db: Db, id: string, at: string): D1PreparedStatement {
	return db.prepare("UPDATE accounts SET last_used_at = ? WHERE id = ?").bind(at, id);
}
