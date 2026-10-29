import { savedContentMeta } from "../content-version";
import {
	assemblePages,
	latestSnapshotGroups,
	physicalKinds,
	type SnapshotPage,
	splitPages,
} from "../snapshot-pages";
import type { Db } from "./d1";

export async function readRepositorySnapshot(db: Db, accountId: string, logical: string) {
	const [a, b] = physicalKinds(logical);
	const rows = await db
		.prepare(
			"SELECT kind,payload,content_meta FROM snapshots WHERE account_id=? AND kind COLLATE NOCASE IN (?,?)",
		)
		.bind(accountId, a, b)
		.all<SnapshotPage>();
	return latestSnapshotGroups(rows.results).get(logical.toLowerCase()) ?? null;
}

export async function readSnapshot(
	db: Db,
	accountId: string,
	logical: string,
): Promise<Record<string, unknown> | null> {
	const [a, b] = physicalKinds(logical);
	const result = await db
		.prepare(
			"SELECT kind, payload, content_meta FROM snapshots WHERE account_id = ? AND kind IN (?, ?)",
		)
		.bind(accountId, a, b)
		.all<SnapshotPage>();
	return snapshotFromRows(logical, result.results);
}

export function snapshotFromRows(
	logical: string,
	rows: SnapshotPage[],
): Record<string, unknown> | null {
	return rows.length === 0 ? null : assemblePages(logical, rows);
}

export async function replaceSnapshotStmts(
	db: Db,
	accountId: string,
	logical: string,
	payload: Record<string, unknown>,
	fetchedAt: string,
): Promise<D1PreparedStatement[]> {
	const [a, b] = physicalKinds(logical);
	const { pages } = splitPages(logical, {
		...payload,
		fetched_at: fetchedAt,
		truncated: payload.truncated === true,
	});
	const metadata = await savedContentMeta(logical, assemblePages(logical, pages));
	const del = db
		.prepare("DELETE FROM snapshots WHERE account_id = ? AND kind IN (?, ?)")
		.bind(accountId, a, b);
	const values = pages.flatMap((page) => [accountId, page.kind, page.payload, fetchedAt, metadata]);
	const placeholders = pages.map(() => "(?, ?, ?, ?, ?)").join(", ");
	const ins = db
		.prepare(
			`INSERT INTO snapshots (account_id, kind, payload, fetched_at, content_meta) VALUES ${placeholders}`,
		)
		.bind(...values);
	return [del, ins];
}
