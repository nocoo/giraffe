import { assemblePages, physicalKinds, type SnapshotPage, splitPages } from "../snapshot-pages";
import type { Db } from "./d1";

export async function readSnapshot(
	db: Db,
	accountId: string,
	logical: string,
): Promise<Record<string, unknown> | null> {
	const [a, b] = physicalKinds(logical);
	const result = await db
		.prepare("SELECT kind, payload FROM snapshots WHERE account_id = ? AND kind IN (?, ?)")
		.bind(accountId, a, b)
		.all<SnapshotPage>();
	if (result.results.length === 0) {
		return null;
	}
	return assemblePages(logical, result.results);
}

export function replaceSnapshotStmts(
	db: Db,
	accountId: string,
	logical: string,
	payload: Record<string, unknown>,
	fetchedAt: string,
): D1PreparedStatement[] {
	const [a, b] = physicalKinds(logical);
	const { pages, truncated } = splitPages(logical, {
		...payload,
		fetched_at: fetchedAt,
		truncated: payload.truncated === true,
	});
	void truncated;
	const del = db
		.prepare("DELETE FROM snapshots WHERE account_id = ? AND kind IN (?, ?)")
		.bind(accountId, a, b);
	const values = pages.flatMap((page) => [accountId, page.kind, page.payload, fetchedAt]);
	const placeholders = pages.map(() => "(?, ?, ?, ?)").join(", ");
	const ins = db
		.prepare(`INSERT INTO snapshots (account_id, kind, payload, fetched_at) VALUES ${placeholders}`)
		.bind(...values);
	return [del, ins];
}
