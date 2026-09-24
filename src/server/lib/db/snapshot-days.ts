import type { Db } from "./d1";

/** Legacy daily baselines are no longer written; pruning lets retained rows age out. */
export function pruneDaysStmt(db: Db, accountId: string, oldest: string): D1PreparedStatement {
	return db
		.prepare("DELETE FROM snapshot_days WHERE account_id = ? AND day < ?")
		.bind(accountId, oldest);
}
