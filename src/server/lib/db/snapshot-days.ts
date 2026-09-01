import type { DayPayload } from "../digest";
import type { Db } from "./d1";

export async function readDay(db: Db, accountId: string, day: string): Promise<DayPayload | null> {
	const row = await db
		.prepare("SELECT payload FROM snapshot_days WHERE account_id = ? AND day = ?")
		.bind(accountId, day)
		.first<{ payload: string }>();
	if (!row) {
		return null;
	}
	return JSON.parse(row.payload) as DayPayload;
}

export function upsertDayStmt(
	db: Db,
	accountId: string,
	day: string,
	payload: DayPayload,
): D1PreparedStatement {
	return db
		.prepare(
			"INSERT INTO snapshot_days (account_id, day, payload) VALUES (?, ?, ?) ON CONFLICT(account_id, day) DO UPDATE SET payload = excluded.payload",
		)
		.bind(accountId, day, JSON.stringify(payload));
}

export function pruneDaysStmt(db: Db, accountId: string, oldest: string): D1PreparedStatement {
	return db
		.prepare("DELETE FROM snapshot_days WHERE account_id = ? AND day < ?")
		.bind(accountId, oldest);
}
