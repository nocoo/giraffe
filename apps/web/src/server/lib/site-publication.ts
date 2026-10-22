import { savedContentMeta } from "./content-version";
import type { Db } from "./db/d1";
import { fenced, type RunLease } from "./db/factory-runs";
import { assembleSnapshotGroups, type SnapshotPage } from "./snapshot-pages";

export async function publishSiteSnapshots(db: Db, lease: RunLease, now: string) {
	const rows = await db
		.prepare(
			"SELECT substr(stream,6) AS kind,payload,content_meta FROM factory_resources WHERE run_id=? AND repo='' AND stream LIKE 'site:%'",
		)
		.bind(lease.run.id)
		.all<SnapshotPage>();
	const publication = { runId: lease.run.id, publishedAt: now };
	const metadata = new Map(
		await Promise.all(
			[...assembleSnapshotGroups(rows.results)].map(
				async ([kind, data]) =>
					[kind, await savedContentMeta(kind, { ...data, publication })] as const,
			),
		),
	);
	const encoded = JSON.stringify(Object.fromEntries(metadata));
	return [
		fenced(
			db,
			lease,
			now,
			"DELETE FROM snapshots WHERE account_id=? AND kind IN (SELECT key FROM json_each(?) UNION ALL SELECT key || '#2' FROM json_each(?)) AND $guard",
			[lease.run.account_id, encoded, encoded],
		),
		fenced(
			db,
			lease,
			now,
			"INSERT INTO snapshots(account_id,kind,payload,fetched_at,content_meta) SELECT ?,substr(staged.stream,6),json_set(staged.payload,'$.publication',json(?)),json_extract(staged.payload,'$.fetched_at'),metadata.value FROM factory_resources staged JOIN json_each(?) metadata ON substr(staged.stream,6) IN (metadata.key,metadata.key || '#2') WHERE staged.run_id=? AND staged.repo='' AND $guard",
			[lease.run.account_id, JSON.stringify(publication), encoded, lease.run.id],
		),
	];
}
