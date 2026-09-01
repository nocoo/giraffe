type Row = Record<string, unknown>;

class Memory {
	accounts: Row[] = [];
	snapshots: Row[] = [];
	days: Row[] = [];
	marker: Row[] = [];
}

class Stmt {
	values: unknown[] = [];
	constructor(
		private readonly mem: Memory,
		private readonly sql: string,
	) {}
	bind(...values: unknown[]): D1PreparedStatement {
		const next = new Stmt(this.mem, this.sql);
		next.values = values;
		return next as unknown as D1PreparedStatement;
	}
	private exec(): Row[] {
		const sql = this.sql.replace(/\s+/g, " ").trim();
		const v = this.values;
		if (sql === "SELECT 1 AS n") {
			return [{ n: 1 }];
		}
		if (sql.startsWith("SELECT * FROM accounts ORDER BY login")) {
			return [...this.mem.accounts].sort((a, b) => String(a.login).localeCompare(String(b.login)));
		}
		if (sql.startsWith("SELECT * FROM accounts WHERE id")) {
			return this.mem.accounts.filter((row) => row.id === v[0]);
		}
		if (sql.startsWith("SELECT * FROM accounts WHERE login")) {
			return this.mem.accounts.filter((row) => row.login === v[0]);
		}
		if (sql.startsWith("SELECT * FROM accounts WHERE is_active")) {
			return this.mem.accounts.filter((row) => row.is_active === 1);
		}
		if (sql.startsWith("SELECT COUNT(*)")) {
			return [{ n: this.mem.accounts.length }];
		}
		if (sql.startsWith("INSERT INTO accounts")) {
			const row: Row = {
				id: v[0],
				login: v[1],
				avatar_url: v[2],
				token_ciphertext: v[3],
				token_last4: v[4],
				key_version: v[5],
				scopes: v[6],
				capabilities: v[7],
				is_active: v[8],
				created_at: v[9],
				updated_at: v[10],
				last_used_at: v[11],
			};
			if (this.mem.accounts.some((existing) => existing.login === row.login)) {
				throw new Error("unique login");
			}
			if (row.is_active === 1 && this.mem.accounts.some((existing) => existing.is_active === 1)) {
				throw new Error("accounts_one_active");
			}
			this.mem.accounts.push(row);
			return [];
		}
		if (sql.startsWith("UPDATE accounts SET avatar_url")) {
			for (const row of this.mem.accounts) {
				if (row.login === v[8]) {
					row.avatar_url = v[0];
					row.token_ciphertext = v[1];
					row.token_last4 = v[2];
					row.key_version = v[3];
					row.scopes = v[4];
					row.capabilities = v[5];
					row.updated_at = v[6];
					row.last_used_at = v[7];
				}
			}
			return [];
		}
		if (sql === "UPDATE accounts SET is_active = 0") {
			for (const row of this.mem.accounts) {
				row.is_active = 0;
			}
			return [];
		}
		if (sql.startsWith("UPDATE accounts SET is_active = 1")) {
			for (const row of this.mem.accounts) {
				if (row.id === v[1]) {
					row.is_active = 1;
					row.updated_at = v[0];
				}
			}
			return [];
		}
		if (sql.startsWith("UPDATE accounts SET last_used_at")) {
			for (const row of this.mem.accounts) {
				if (row.id === v[1]) {
					row.last_used_at = v[0];
				}
			}
			return [];
		}
		if (sql.startsWith("DELETE FROM accounts")) {
			this.mem.accounts = this.mem.accounts.filter((row) => row.id !== v[0]);
			this.mem.snapshots = this.mem.snapshots.filter((row) => row.account_id !== v[0]);
			this.mem.days = this.mem.days.filter((row) => row.account_id !== v[0]);
			return [];
		}
		if (sql.startsWith("SELECT kind, payload FROM snapshots")) {
			return this.mem.snapshots.filter(
				(row) => row.account_id === v[0] && (row.kind === v[1] || row.kind === v[2]),
			);
		}
		if (sql.startsWith("DELETE FROM snapshots")) {
			this.mem.snapshots = this.mem.snapshots.filter(
				(row) => !(row.account_id === v[0] && (row.kind === v[1] || row.kind === v[2])),
			);
			return [];
		}
		if (sql.startsWith("INSERT INTO snapshots")) {
			for (let i = 0; i + 3 < v.length; i += 4) {
				this.mem.snapshots.push({
					account_id: v[i],
					kind: v[i + 1],
					payload: v[i + 2],
					fetched_at: v[i + 3],
				});
			}
			return [];
		}
		if (sql.startsWith("SELECT payload FROM snapshot_days")) {
			return this.mem.days.filter((row) => row.account_id === v[0] && row.day === v[1]);
		}
		if (sql.startsWith("INSERT INTO snapshot_days")) {
			this.mem.days = this.mem.days.filter((row) => !(row.account_id === v[0] && row.day === v[1]));
			this.mem.days.push({ account_id: v[0], day: v[1], payload: v[2] });
			return [];
		}
		if (sql.startsWith("DELETE FROM snapshot_days")) {
			this.mem.days = this.mem.days.filter(
				(row) => !(row.account_id === v[0] && String(row.day) < String(v[1])),
			);
			return [];
		}
		if (sql.startsWith("SELECT value FROM _test_marker")) {
			return this.mem.marker.filter((row) => row.key === v[0]);
		}
		throw new Error(`unsupported sql: ${sql}`);
	}
	async first<T = Record<string, unknown>>(): Promise<T | null> {
		return (this.exec()[0] as T | undefined) ?? null;
	}
	async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		return { results: this.exec() as T[], success: true, meta: {} } as D1Result<T>;
	}
	async run(): Promise<D1Result> {
		this.exec();
		return { success: true, meta: {} } as D1Result;
	}
}

export function openSqliteD1(marker = false): D1Database {
	const mem = new Memory();
	if (marker) {
		mem.marker.push({ key: "env", value: "test" });
	}
	return {
		prepare: (sql: string) => new Stmt(mem, sql) as unknown as D1PreparedStatement,
		batch: async (statements: D1PreparedStatement[]) => {
			const out: D1Result[] = [];
			for (const statement of statements) {
				out.push(await statement.run());
			}
			return out;
		},
		dump: async () => "",
		exec: async () => ({ count: 0, duration: 0 }),
	} as unknown as D1Database;
}
