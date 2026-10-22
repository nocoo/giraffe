import { savedContentMeta } from "../content-version";
import { ApiError } from "../errors";
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
	stageRunId?: string,
): Promise<Record<string, unknown> | null> {
	const [a, b] = physicalKinds(logical);
	if (stageRunId) {
		const staged = await db
			.prepare(
				"SELECT substr(stream,6) AS kind,payload,content_meta FROM factory_resources WHERE run_id=? AND repo='' AND stream IN (?,?)",
			)
			.bind(stageRunId, `site:${a}`, `site:${b}`)
			.all<SnapshotPage>();
		if (staged.results.length) return snapshotFromRows(logical, staged.results);
	}
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
	stageRunId?: string,
): Promise<D1PreparedStatement[]> {
	const [a, b] = physicalKinds(logical);
	const { pages, capacityExceeded } = splitPages(logical, {
		...payload,
		...(stageRunId
			? { publication: { runId: stageRunId, publishedAt: "0000-01-01T00:00:00.000Z" } }
			: {}),
		fetched_at: fetchedAt,
		truncated: payload.truncated === true,
	});
	if (stageRunId && capacityExceeded)
		throw new ApiError(422, "snapshot_incomplete", "Final snapshot exceeds bounded storage");
	const metadata = await savedContentMeta(logical, assemblePages(logical, pages));
	if (stageRunId)
		return [
			db
				.prepare("DELETE FROM factory_resources WHERE run_id=? AND repo='' AND stream IN (?,?)")
				.bind(stageRunId, `site:${a}`, `site:${b}`),
			...pages.map((page) =>
				db
					.prepare(
						"INSERT INTO factory_resources(run_id,repo,stream,payload,content_meta) VALUES(?,'',?,?,?)",
					)
					.bind(stageRunId, `site:${page.kind}`, page.payload, metadata),
			),
		];
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
